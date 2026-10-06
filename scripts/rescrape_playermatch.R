# rescrape_playermatch.R
#
# Re-scrapes NCAA D1 women's volleyball per-match player stats using the
# ncaavolleyballr package's contest-based endpoint, KEEPING BOTH teams'
# rosters for every match. The bundled data-csv files in that package are
# one-sided (team filter applied + dedup by contest); this script avoids
# both issues by iterating unique contest IDs and calling
# player_match_stats(contest) with no team argument.
#
# Usage (in R console):
#
#   setwd("C:/Users/gordo/OneDrive/Documents/GitHub/volleyball-gis/.claude/worktrees/sharp-elgamal")
#   source("scripts/rescrape_playermatch.R")
#   rescrape_year(2022)     # run one at a time; 45-90 min each
#   rescrape_year(2023)
#   rescrape_year(2024)
#   rescrape_year(2025)
#
# Resumable: each contest is cached to scripts/.playermatch-cache/<year>/<cid>.rds
# before moving on. If interrupted, rerun rescrape_year(YEAR) — already-cached
# contests are skipped, throttle sleeps and HTTP calls only fire for missing
# ones. Failures are logged to _failures.csv in the same directory.
#
# Output: public/data/wvb_playermatch_div1_<year>_twosided.csv

suppressPackageStartupMessages({
  library(dplyr)
  library(readr)
  library(purrr)
  library(ncaavolleyballr)
})

# ── Config ────────────────────────────────────────────────────────────────────
CACHE_ROOT   <- "scripts/.playermatch-cache"
OUTPUT_DIR   <- "public/data"
THROTTLE_SEC <- 2.5           # delay between HTTP calls (Akamai bot-mgmt is aggressive)
PROGRESS_EVERY <- 25          # print progress every N contests

# ── Helpers ───────────────────────────────────────────────────────────────────

cache_dir <- function(year) file.path(CACHE_ROOT, as.character(year))

ensure_dirs <- function(year) {
  dir.create(cache_dir(year), recursive = TRUE, showWarnings = FALSE)
  dir.create(OUTPUT_DIR,       recursive = TRUE, showWarnings = FALSE)
}

# Get all D1 WVB team_ids for a given fall-year. Requires ncaavolleyballr's
# built-in wvb_teams dataset to have that year.
d1_team_ids_for_year <- function(year) {
  data("wvb_teams", package = "ncaavolleyballr", envir = environment())
  teams <- get("wvb_teams")
  ids <- teams %>%
    filter(div == 1, yr == year) %>%
    pull(team_id) %>%
    unique() %>%
    na.omit()
  cat(sprintf("  %d D1 WVB teams for %d\n", length(ids), year))
  ids
}

# Gather every contest ID appearing on any D1 team's schedule. Returns a
# character vector of unique contest IDs.
enumerate_contest_ids <- function(team_ids) {
  cat(sprintf("  Enumerating contests across %d teams…\n", length(team_ids)))
  all_ids <- c()
  failures <- 0
  for (i in seq_along(team_ids)) {
    tid <- team_ids[i]
    contests <- tryCatch(
      find_team_contests(tid),
      error = function(e) { failures <<- failures + 1; NULL }
    )
    if (!is.null(contests) && "contest" %in% names(contests)) {
      all_ids <- c(all_ids, as.character(contests$contest))
    }
    if (i %% 25 == 0) {
      cat(sprintf("    %d/%d teams (%d unique contests, %d failures)\n",
                  i, length(team_ids), length(unique(all_ids)), failures))
    }
    Sys.sleep(THROTTLE_SEC)
  }
  unique(all_ids[!is.na(all_ids) & nzchar(all_ids)])
}

# Fetch one contest, write to cache. Returns TRUE on success, FALSE on failure.
fetch_one_contest <- function(cid, year) {
  cache_path <- file.path(cache_dir(year), paste0(cid, ".rds"))
  if (file.exists(cache_path)) return(TRUE)    # already cached → skip

  res <- tryCatch(
    player_match_stats(cid, sport = "WVB"),
    error = function(e) structure(list(error = conditionMessage(e)), class = "pms_error")
  )
  if (inherits(res, "pms_error")) {
    log_failure(cid, year, res$error)
    return(FALSE)
  }
  # Skip caching empty / NULL / zero-row results so re-runs retry them.
  if (is.null(res) ||
      (is.data.frame(res) && nrow(res) == 0) ||
      (is.list(res) && !is.data.frame(res) &&
         (length(res) == 0 || sum(sapply(res, function(z) if (is.data.frame(z)) nrow(z) else 0)) == 0))) {
    log_failure(cid, year, "empty result (NULL or 0 rows)")
    return(FALSE)
  }
  saveRDS(res, cache_path)
  TRUE
}

log_failure <- function(cid, year, msg) {
  fp <- file.path(cache_dir(year), "_failures.csv")
  line <- data.frame(
    contest = cid, time = format(Sys.time()), error = substr(msg, 1, 200)
  )
  write.table(line, fp, append = file.exists(fp),
              sep = ",", row.names = FALSE,
              col.names = !file.exists(fp))
}

# Assemble all cached per-contest data frames into one CSV.
assemble_csv <- function(year) {
  cache <- cache_dir(year)
  rds_files <- list.files(cache, pattern = "^\\d+\\.rds$", full.names = TRUE)
  cat(sprintf("  Reading %d cached contests…\n", length(rds_files)))
  rows <- map_dfr(rds_files, function(fp) {
    x <- tryCatch(readRDS(fp), error = function(e) NULL)
    if (is.null(x)) return(NULL)
    # player_match_stats returns either a tibble (both teams combined) or a
    # list of tibbles. Normalize to a single data frame.
    if (is.data.frame(x)) return(x)
    if (is.list(x)) return(bind_rows(x))
    NULL
  })
  out_path <- file.path(OUTPUT_DIR,
                        sprintf("wvb_playermatch_div1_%d_twosided.csv", year))
  write_csv(rows, out_path, na = "")
  cat(sprintf("  Wrote %s (%d rows)\n", out_path, nrow(rows)))
  invisible(out_path)
}

# ── Main ──────────────────────────────────────────────────────────────────────

rescrape_year <- function(year) {
  cat(sprintf("\n═══ Rescrape %d ═══\n", year))
  ensure_dirs(year)

  # 1. Enumerate unique contest IDs for this season
  enum_cache <- file.path(cache_dir(year), "_contest_ids.rds")
  if (file.exists(enum_cache)) {
    contest_ids <- readRDS(enum_cache)
    cat(sprintf("  Loaded cached contest list (%d ids)\n", length(contest_ids)))
  } else {
    team_ids <- d1_team_ids_for_year(year)
    if (length(team_ids) == 0) {
      stop(sprintf("No D1 WVB teams found for %d — wvb_teams may not cover this year. ",
                   year),
           "Try updating the package: remotes::install_github('JeffreyRStevens/ncaavolleyballr')")
    }
    contest_ids <- enumerate_contest_ids(team_ids)
    saveRDS(contest_ids, enum_cache)
    cat(sprintf("  Cached %d contest IDs to %s\n", length(contest_ids), enum_cache))
  }

  # 2. Fetch each contest (skip already-cached)
  cat(sprintf("  Fetching player_match_stats for %d contests…\n", length(contest_ids)))
  start <- Sys.time()
  success <- 0; failure <- 0; skipped <- 0
  for (i in seq_along(contest_ids)) {
    cid <- contest_ids[i]
    already <- file.exists(file.path(cache_dir(year), paste0(cid, ".rds")))
    if (already) { skipped <- skipped + 1; next }

    ok <- fetch_one_contest(cid, year)
    if (ok) success <- success + 1 else failure <- failure + 1
    Sys.sleep(THROTTLE_SEC)

    if (i %% PROGRESS_EVERY == 0) {
      elapsed <- as.numeric(difftime(Sys.time(), start, units = "secs"))
      remaining <- length(contest_ids) - i
      rate <- max((success + failure) / max(elapsed, 1), 0.01)
      eta_min <- remaining / rate / 60
      cat(sprintf("    %d/%d · %d cached · %d new · %d fail · ETA %.0f min\n",
                  i, length(contest_ids), skipped, success, failure, eta_min))
    }
  }
  cat(sprintf("  Done: %d newly fetched · %d skipped · %d failed\n",
              success, skipped, failure))

  # 3. Assemble CSV from cache
  assemble_csv(year)
}

# Convenience: if you want to re-assemble without re-fetching
rebuild_csv_from_cache <- function(year) {
  ensure_dirs(year)
  assemble_csv(year)
}

cat("Loaded rescrape_playermatch.R\n")
cat("Available functions:\n")
cat("  rescrape_year(year)              - fetch + assemble (resumable)\n")
cat("  rebuild_csv_from_cache(year)     - re-assemble CSV from existing cache\n")
cat("Example:  rescrape_year(2024)\n")
