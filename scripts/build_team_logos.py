"""
build_team_logos.py

One-time build pipeline: fetch the ESPN NCAAW volleyball team roster,
download each team's 500px logo, convert to WebP, and emit a mapping
file keyed by our in-app team names.

Outputs:
  public/logos/<espn-slug>.webp   — one logo per matched team
  src/data/teamLogos.js           — { "pittsburgh": "/logos/pitt.webp", … }
  scripts/.pbp-build/teamLogos_unmatched.txt  — our teams with no ESPN match

Our in-app team names come from the playermatch CSVs (Team column).
ESPN's team.location field matches our naming well in most cases; we
apply a small set of hand-written aliases for the usual suspects
(state → st., punctuation differences, program rebrands). After the
alias layer, the remaining gaps are logged, not fatal.
"""
import csv
import io
import json
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

from PIL import Image

ESPN_API = (
    'https://site.api.espn.com/apis/site/v2/sports/volleyball/'
    'womens-college-volleyball/teams?limit=500'
)
UA = 'Mozilla/5.0 (volleyball-gis logo builder)'

REPO_ROOT    = Path(__file__).resolve().parent.parent
LOGO_DIR     = REPO_ROOT / 'public' / 'logos'
OUTPUT_JS    = REPO_ROOT / 'src' / 'data' / 'teamLogos.js'
UNMATCHED    = REPO_ROOT / 'scripts' / '.pbp-build' / 'teamLogos_unmatched.txt'
CSV_GLOB     = 'public/data/wvb_playermatch_div1_*.csv'
RPI_PATH     = REPO_ROOT / 'public' / 'data' / 'historical_rpi.json'

# Manual aliases: our in-app team name → ESPN location (lowercased).
# Only fill when the automated matcher misses — we add these as we see
# them. A left-hand side of '' means "skip this team, no logo needed."
MANUAL_ALIASES = {
    # State abbreviations ESPN spells out
    'mississippi st.':  'mississippi state',
    'michigan st.':     'michigan state',
    'ohio st.':         'ohio state',
    'penn st.':         'penn state',
    'iowa st.':         'iowa state',
    'oklahoma st.':     'oklahoma state',
    'kansas st.':       'kansas state',
    'arizona st.':      'arizona state',
    'oregon st.':       'oregon state',
    'washington st.':   'washington state',
    'colorado st.':     'colorado state',
    'utah st.':         'utah state',
    'boise st.':        'boise state',
    'florida st.':      'florida state',
    'san diego st.':    'san diego state',
    'san jose st.':     'san jose state',
    'wichita st.':      'wichita state',
    'arkansas st.':     'arkansas state',
    'ball st.':         'ball state',
    'wright st.':       'wright state',
    'cleveland st.':    'cleveland state',
    'kent st.':         'kent state',
    'youngstown st.':   'youngstown state',
    'portland st.':     'portland state',
    'sacramento st.':   'sacramento state',
    'fresno st.':       'fresno state',
    'long beach st.':   'long beach state',
    'montana st.':      'montana state',
    'nc state':         'nc state',
    'n.c. state':       'nc state',
    'north carolina st.': 'nc state',
    'mcneese st.':      'mcneese state',
    'missouri st.':     'missouri state',
    'morehead st.':     'morehead state',
    'tennessee st.':    'tennessee state',
    'alabama st.':      'alabama state',
    'alcorn st.':       'alcorn state',
    'arkansas-pine bluff': 'arkansas-pine bluff',
    'north dakota st.': 'north dakota state',
    'south dakota st.': 'south dakota state',
    'northern ariz.':   'northern arizona',
    'northern colo.':   'northern colorado',
    'northern ill.':    'northern illinois',
    'northern iowa':    'northern iowa',
    'niu':              'northern illinois',
    'uni':              'northern iowa',
    'bowling green':    'bowling green',
    'western ky.':      'western kentucky',
    'eastern ky.':      'eastern kentucky',
    'eastern mich.':    'eastern michigan',
    'central mich.':    'central michigan',
    'western mich.':    'western michigan',
    'eastern ill.':     'eastern illinois',
    'eastern wash.':    'eastern washington',
    'western ill.':     'western illinois',
    'southern ill.':    'southern illinois',
    'southern miss.':   'southern miss',
    'southern utah':    'southern utah',
    'southern ind.':    'southern indiana',
    'tenn.-martin':     'tennessee-martin',
    'ut martin':        'tennessee-martin',
    'tennessee tech':   'tennessee tech',
    'tenn. tech':       'tennessee tech',
    'tennessee st.':    'tennessee state',
    'austin peay':      'austin peay',
    'ab.-christian':    'abilene christian',
    'abilene christian': 'abilene christian',
    'uc santa barbara': 'uc santa barbara',
    'ucsb':             'uc santa barbara',
    'uc irvine':        'uc irvine',
    'uc davis':         'uc davis',
    'uc riverside':     'uc riverside',
    'uc san diego':     'uc san diego',
    'csu bakersfield':  'cal state bakersfield',
    'csu fullerton':    'cal state fullerton',
    'csun':             'cal state northridge',
    'cal poly':         'cal poly',
    'san francisco':    'san francisco',
    'santa clara':      'santa clara',
    'ipfw':             'purdue fort wayne',
    'purdue fw':        'purdue fort wayne',
    'ipfw ':            'purdue fort wayne',
    'ucf':              'ucf',
    'smu':              'smu',
    'byu':              'byu',
    'tcu':              'tcu',
    'lsu':              'lsu',
    'ucla':             'ucla',
    'usc':              'usc',
    'nyu':              'nyu',
    'utsa':             'utsa',
    'utep':             'utep',
    'uab':              'uab',
    'uic':              'uic',
    'uiw':              'incarnate word',
    'nmsu':             'new mexico state',
    'new mexico st.':   'new mexico state',
    'nm state':         'new mexico state',
    'lmu (ca)':         'loyola marymount',
    'loyola marymount': 'loyola marymount',
    'loyola chicago':   'loyola chicago',
    'loyola maryland':  'loyola maryland',
    'siu edwardsville': 'siu edwardsville',
    'st. francis (pa)': 'saint francis',
    'st. francis pa':   'saint francis',
    'saint francis':    'saint francis',
    'st. francis bk':   'st francis brooklyn',
    'saint francis bk': 'st francis brooklyn',
    "saint mary's (ca)": "saint mary's",
    "saint joseph's":   "saint joseph's",
    'st. bonaventure':  'st. bonaventure',
    "st. john's (ny)":  "st. john's",
    'omaha':            'omaha',
    'new orleans':      'new orleans',
    'lsu new orleans':  'new orleans',
    'uno (la)':         'new orleans',
    'tex. a&m-commerce': 'east texas a&m',
    'east texas a&m':   'east texas a&m',
    'texas a&m-cc':     "texas a&m–corpus christi",
    'a&m-corpus christi': "texas a&m–corpus christi",
    "fla. gulf coast":  'florida gulf coast',
    "fgcu":             'florida gulf coast',
    'fiu':              'fiu',
    'fdu':              'fairleigh dickinson',
    'pitt':             'pittsburgh',
    'ole miss':         'ole miss',
    'miami (oh)':       'miami (ohio)',
    'miami (fl)':       'miami',
    'miami':            'miami',
    'western caro.':    'western carolina',
    'east carolina':    'east carolina',
    'ecu':              'east carolina',
    'odu':              'old dominion',
    'old dominion':     'old dominion',
    "hawai'i":          "hawai'i",
    'hawaii':           "hawai'i",
    'long island':      'liu',
    'liu':              'liu',
    'siu':              'southern illinois',
    'etsu':             'east tennessee state',
    'east tennessee state': 'east tennessee state',
    'presbyterian':     'presbyterian',
    'high point':       'high point',
    'queens':           'queens university',
    'queens (nc)':      'queens university',
    'charleston':       'charleston',
    'col. of charleston': 'charleston',
    'cofc':             'charleston',
    'charleston so.':   'charleston southern',
    'coastal carolina': 'coastal carolina',
    'ga. southern':     'georgia southern',
    'georgia southern': 'georgia southern',
    'ga. tech':         'georgia tech',
    'georgia tech':     'georgia tech',
    'ga. state':        'georgia state',
    'georgia state':    'georgia state',
    'ga. st.':          'georgia state',
    'james madison':    'james madison',
    'jmu':              'james madison',
    'uconn':            'connecticut',
    'cal':              'california',
    'california':       'california',
    'vcu':              'vcu',
    'wku':              'western kentucky',
    'louisiana':        'louisiana',
    'ul monroe':        'louisiana-monroe',
    'ulm':              'louisiana-monroe',
    'louisiana tech':   'louisiana tech',
    'ull':              'louisiana',
    'southeastern la.': 'southeastern louisiana',
    'southeastern louisiana': 'southeastern louisiana',
    'mcneese':          'mcneese',
    'nicholls':         'nicholls',
    'houston christian': 'houston christian',
    'incarnate word':   'incarnate word',
    'tarleton st.':     'tarleton state',
    'utrgv':            'utrgv',
    'ut rio grande valley': 'utrgv',
    'uttyler':          'ut tyler',
    'west florida':     'west florida',
    'new hampshire':    'new hampshire',
    'southeast mo. st.': 'southeast missouri state',
    'southeast mo st':  'southeast missouri state',
    'semo':             'southeast missouri state',
    'uma lowell':       'umass lowell',
    'umass lowell':     'umass lowell',
    'umbc':             'umbc',
    'umass':            'massachusetts',
    'army':             'army',
    'navy':             'navy',
    'air force':        'air force',
    'depaul':           'depaul',
    'drake':            'drake',
    'denver':           'denver',
    'dayton':           'dayton',
    'duquesne':         'duquesne',
    'fordham':          'fordham',
    'rider':            'rider',
    'marist':           'marist',
    'manhattan':        'manhattan',
    'quinnipiac':       'quinnipiac',
    'iona':             'iona',
    'siena':            'siena',
    'canisius':         'canisius',
    'niagara':          'niagara',
    'merrimack':        'merrimack',
    'sacred heart':     'sacred heart',
    'sfny':             'st francis brooklyn',
    'ccsu':             'central connecticut',
    'central conn. st.': 'central connecticut',
    'central conn.':    'central connecticut',
    'central connecticut': 'central connecticut',
    "md.-east. shore":  'maryland-eastern shore',
    'md. eastern shore': 'maryland-eastern shore',
    'umes':             'maryland-eastern shore',
    'southern-n.o.':    'southern-n.o.',  # likely won't match
    'souther-n.o.':     '',  # non-D1
    'northwestern st.': 'northwestern state',
    'northwestern state': 'northwestern state',
    'stephen f. austin': 'stephen f. austin',
    'sfa':              'stephen f. austin',
    'ga southern':      'georgia southern',
    'a&m-commerce':     'east texas a&m',
    'texas southern':   'texas southern',
    'texas state':      'texas state',
    'bryant':           'bryant',
    'bellarmine':       'bellarmine',
    'lipscomb':         'lipscomb',
    'belmont':          'belmont',
    'furman':           'furman',
    'mercer':           'mercer',
    'richmond':         'richmond',
    'xavier':           'xavier',
    'saint louis':      'saint louis',
    'wofford':          'wofford',
    'the citadel':      'the citadel',
    'citadel':          'the citadel',
    'samford':          'samford',
    'south florida':    'south florida',
    'usf':              'south florida',
    'north florida':    'north florida',
    'stetson':          'stetson',
    'bethune-cookman':  'bethune-cookman',
    'mississippi val.': 'mississippi valley state',
    'miss. val. st.':   'mississippi valley state',
    'sc state':         'south carolina state',
    'south carolina st.': 'south carolina state',
    'n.c. a&t':         'nc a&t',
    'nc a&t':           'nc a&t',
    'north carolina a&t': 'nc a&t',
    'n.c. central':     'north carolina central',
    'nccu':             'north carolina central',
    'north carolina central': 'north carolina central',
    'unc wilmington':   'unc wilmington',
    'unc greensboro':   'unc greensboro',
    'uncw':             'unc wilmington',
    'uncg':             'unc greensboro',
    'north carolina':   'north carolina',
    'tennessee':        'tennessee',
    'army west point':  'army',
    'sam houston':      'sam houston',
    'tx a&m-corpus chr.': 'texas a&m-corpus christi',
    'portland':         'portland',
    'san diego':        'san diego',
    'south dakota':     'south dakota',
    'north dakota':     'north dakota',
    'north dakota state': 'north dakota state',
    'oakland':          'oakland',
    'youngstown state': 'youngstown state',
    'milwaukee':        'milwaukee',
    'green bay':        'green bay',
    'wis.-green bay':   'green bay',
    'wis.-milwaukee':   'milwaukee',
    'ill.-chicago':     'uic',
    'uw-milwaukee':     'milwaukee',
    'uw-green bay':     'green bay',
    'uw milwaukee':     'milwaukee',
    'uw green bay':     'green bay',
    'uw-madison':       'wisconsin',
    'ohio':             'ohio',
    'toledo':           'toledo',
    'buffalo':          'buffalo',
    'akron':            'akron',
    'elon':             'elon',
    'drexel':           'drexel',
    'delaware':         'delaware',
    'temple':           'temple',
    'villanova':        'villanova',
    'la salle':         'la salle',
    'george washington': 'george washington',
    'george mason':     'george mason',
    'davidson':         'davidson',
    'wagner':           'wagner',
    'marshall':         'marshall',
    'liberty':          'liberty',
    'troy':             'troy',
    'appalachian st.':  'appalachian state',
    'app state':        'appalachian state',
    'app st.':          'appalachian state',
    'louisiana-lafayette': 'louisiana',
    'texas-arlington':  'ut arlington',
    'ut arlington':     'ut arlington',
    'charlotte':        'charlotte',
    'north texas':      'north texas',
    'rice':             'rice',
    'tulane':           'tulane',
    'tulsa':            'tulsa',
    'memphis':          'memphis',
    'cincinnati':       'cincinnati',
    'east carolina':    'east carolina',
    'houston':          'houston',
    'kennesaw st.':     'kennesaw state',
    'kennesaw state':   'kennesaw state',
    'jacksonville st.': 'jacksonville state',
    'jacksonville state': 'jacksonville state',
    'jax state':        'jacksonville state',
    'florida international': 'fiu',
    'chattanooga':      'chattanooga',
    'uc chattanooga':   'chattanooga',
    'tenn.-chattanooga': 'chattanooga',
    'wofford':          'wofford',
    'vmi':              'vmi',
    'elon':             'elon',
    'longwood':         'longwood',
    'norfolk st.':      'norfolk state',
    'norfolk state':    'norfolk state',
    'towson':           'towson',
    'morgan st.':       'morgan state',
    'morgan state':     'morgan state',
    'howard':           'howard',
    'delaware st.':     'delaware state',
    'delaware state':   'delaware state',
    'sc upstate':       'usc upstate',
    'usc upstate':      'usc upstate',
    'gardner-webb':     'gardner-webb',
    'radford':          'radford',
    'longwood':         'longwood',
    'win-salem':        'winthrop',
    'winthrop':         'winthrop',
    'campbell':         'campbell',
    'western carolina': 'western carolina',
    'western caro.':    'western carolina',
    'florida a&m':      'florida a&m',
    'alabama a&m':      'alabama a&m',
    'ark.-pine bluff':  'arkansas-pine bluff',
    'ark pine bluff':   'arkansas-pine bluff',
    'grambling':        'grambling',
    'southern u.':      'southern',
    'southern':         'southern',
    'southern univ.':   'southern',
    'southern jaguars': 'southern',
    'sfa':              'stephen f. austin',
    'louisville':       'louisville',
    'kentucky':         'kentucky',
    'notre dame':       'notre dame',
    'syracuse':         'syracuse',
    'wake forest':      'wake forest',
    'duke':             'duke',
    'virginia':         'virginia',
    'virginia tech':    'virginia tech',
    'clemson':          'clemson',
    'arkansas':         'arkansas',
    'ark. little rock': 'little rock',
    'little rock':      'little rock',
    'ark.-little rock': 'little rock',
    'southern miss':    'southern miss',
    'trumbull':         '',
    'sc st.':           'south carolina state',
    'uc riverside':     'uc riverside',
    'cal state fullerton': 'cal state fullerton',
    'cal state northridge': 'cal state northridge',
    'cal state bakersfield': 'cal state bakersfield',
    'san diego state':  'san diego state',
    'bgsu':             'bowling green',
    'army ':            'army',
    'navy ':            'navy',
    'presbyterian col.': 'presbyterian',
    'tenn.':            'tennessee',
    # Second-pass misses discovered via unmatched report
    'a&m-corpus christi': 'texas a&m-corpus christi',
    'alcorn':           'alcorn state',
    'cal st. fullerton': 'cal state fullerton',
    'central ark.':     'central arkansas',
    'fla. atlantic':    'florida atlantic',
    'liu':              'long island university',
    'middle tenn.':     'middle tennessee',
    'new orleans':      'lsu new orleans',
    'north ala.':       'north alabama',
    'northern ky.':     'northern kentucky',
    'seattle u':        'seattle university',
    'south fla.':       'south florida',
    'southern california': 'usc',
    'san jose st.':     'san jose state',
    'st. thomas (mn)':  'st. thomas',
    'ulm':              'ul monroe',
    'umes':             'maryland eastern shore',
    'usc upstate':      'south carolina upstate',
    'utrgv':            'ut rio grande valley',
    'west ga.':         'west georgia',
    # Programs NOT in ESPN's current NCAAW volleyball list — mark empty to
    # avoid spurious matches / download attempts. Teams will keep their
    # colored dot. Candidates for a manual secondary-source pass later:
    'delaware':         '',   # ESPN only has Delaware State here
    'hartford':         '',   # Hartford dropped athletics
    'lamar university': '',   # Lamar not in ESPN volleyball list
    'merrimack':        '',   # recent D1 add, not yet in list
    'missouri st.':     '',   # Missouri State (MO State Bears)
    'old dominion':     '',
    'saint francis':    '',   # St Francis PA — new to D1
    'st. francis brooklyn': '',  # discontinued
    'uc san diego':     '',   # not in ESPN
    'vanderbilt':       '',   # dropped volleyball
    'west florida':     '',   # new D1
}

def fetch_espn():
    req = urllib.request.Request(ESPN_API, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    return data['sports'][0]['leagues'][0]['teams']

def collect_our_teams():
    """Union of every D1 team name across RPI and playermatch CSVs."""
    rpi = json.loads(RPI_PATH.read_text(encoding='utf-8'))
    d1 = set()
    for yr, tbl in rpi.items():
        for t in tbl:
            if t == '_neutral_point':
                continue
            d1.add(t.strip())
    # Also include team names from the CSVs that match any D1 team
    # (RPI drives the canonical list).
    return d1

def slugify(s):
    s = re.sub(r'[^\w]+', '-', s.lower().strip())
    return re.sub(r'-+', '-', s).strip('-')

def match_team(our_name, espn_by_key):
    """Try multiple keys to find an ESPN team for our team name."""
    nm = our_name.lower().strip()
    # 1) manual alias
    if nm in MANUAL_ALIASES:
        tgt = MANUAL_ALIASES[nm]
        if tgt == '':
            return None
        if tgt in espn_by_key:
            return espn_by_key[tgt]
    # 2) exact location match
    if nm in espn_by_key:
        return espn_by_key[nm]
    # 3) 'st.' → 'state'
    exp = re.sub(r'\bst\.?\b', 'state', nm)
    if exp in espn_by_key:
        return espn_by_key[exp]
    # 4) drop punctuation
    stripped = re.sub(r'[.\']', '', nm)
    if stripped in espn_by_key:
        return espn_by_key[stripped]
    # 5) 'state' → 'st' (reverse)
    rev = re.sub(r'\bstate\b', 'st.', nm)
    if rev in espn_by_key:
        return espn_by_key[rev]
    # 6) try ESPN displayName / shortDisplayName / nickname
    return None

def download_logo(url, out_path):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    img = Image.open(io.BytesIO(raw)).convert('RGBA')
    # Trim perfectly-transparent border and re-fit to 256×256 (plenty for
    # UI chips, way smaller than the 500×500 source).
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    img.thumbnail((256, 256), Image.LANCZOS)
    img.save(out_path, 'webp', quality=85, method=6)

def main():
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    UNMATCHED.parent.mkdir(parents=True, exist_ok=True)

    print('[logos] fetching ESPN team list…')
    espn_teams = fetch_espn()
    print(f'[logos] ESPN returned {len(espn_teams)} teams')

    # Strip diacritics so "San José State" and "San Jose State" collide.
    def fold(s):
        return ''.join(
            c for c in unicodedata.normalize('NFKD', s or '')
            if not unicodedata.combining(c)
        ).lower().strip()

    espn_by_key = {}
    for te in espn_teams:
        t = te['team']
        keys = set()
        for field in ('location', 'displayName', 'shortDisplayName', 'nickname', 'name', 'abbreviation'):
            v = fold(t.get(field) or '')
            if v: keys.add(v)
        for k in keys:
            if k not in espn_by_key:
                espn_by_key[k] = t

    our_teams = sorted(collect_our_teams())
    print(f'[logos] our D1 teams: {len(our_teams)}')

    mapping = {}   # our_name → relative public URL
    unmatched = [] # our_name without a hit
    downloaded = set()  # espnId already written

    for name in our_teams:
        t = match_team(name, espn_by_key)
        if not t:
            unmatched.append(name)
            continue
        espnid = t['id']
        slug = slugify(t.get('location') or t.get('displayName') or f'id-{espnid}')
        out_rel = f'/logos/{slug}.webp'
        out_path = LOGO_DIR / f'{slug}.webp'
        if espnid not in downloaded:
            # ESPN logo URL — prefer the 'default' (light-background) variant.
            default_logo = None
            for L in t.get('logos') or []:
                if 'dark' not in (L.get('rel') or []):
                    default_logo = L.get('href')
                    break
            if not default_logo and t.get('logos'):
                default_logo = t['logos'][0].get('href')
            if not default_logo:
                unmatched.append(f'{name} (ESPN id {espnid} had no logos)')
                continue
            try:
                download_logo(default_logo, out_path)
                downloaded.add(espnid)
                time.sleep(0.05)  # be polite
            except Exception as e:
                unmatched.append(f'{name} (download failed: {e})')
                continue
        mapping[name.lower().strip()] = out_rel

    # Emit mapping file.
    lines = [
        '/**',
        ' * teamLogos.js — AUTO-GENERATED by scripts/build_team_logos.py.',
        ' *',
        " * Maps our in-app team names (lowercased, matching schoolColors.js keys)",
        ' * to a public /logos/*.webp URL. Source: ESPN NCAAW volleyball teams.',
        ' * Re-run the build script to refresh or add teams.',
        ' */',
        '',
        'const TEAM_LOGOS = {',
    ]
    for k in sorted(mapping):
        v = mapping[k]
        key = k.replace("'", "\\'")
        lines.append(f"  '{key}': '{v}',")
    lines += [
        '};',
        '',
        'function normalize(name) {',
        "  return (name || '').toLowerCase().trim().replace(/\\s+/g, ' ');",
        '}',
        '',
        'export function getTeamLogo(name) {',
        '  return TEAM_LOGOS[normalize(name)] || null;',
        '}',
        '',
        'export function hasTeamLogo(name) {',
        '  return Object.prototype.hasOwnProperty.call(TEAM_LOGOS, normalize(name));',
        '}',
        '',
    ]
    OUTPUT_JS.write_text('\n'.join(lines), encoding='utf-8')
    print(f'[logos] wrote {OUTPUT_JS} with {len(mapping)} teams')

    UNMATCHED.write_text('\n'.join(unmatched) + '\n', encoding='utf-8')
    print(f'[logos] {len(unmatched)} unmatched (see {UNMATCHED.relative_to(REPO_ROOT)})')

    # Quick size summary
    total = sum(p.stat().st_size for p in LOGO_DIR.glob('*.webp'))
    print(f'[logos] {len(list(LOGO_DIR.glob("*.webp")))} .webp files, {total/1024/1024:.1f} MB total')

if __name__ == '__main__':
    main()
