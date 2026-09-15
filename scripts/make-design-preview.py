"""Generate the design-review pages (dev artifacts, not shipped code).

scripts/design-frame.html  - a phone-sized document (iframe target) built from
                             the SHIPPED chrome markup + the shipped CSS, so a
                             desktop browser can look at the real <=720px rules.
scripts/design-preview.html - the review page: two phones (feed / More sheet)
                             plus the desktop hero, rows, tooltip and detail card.

Run from the repo root:  python3 scripts/make-design-preview.py
"""
import os
import re

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
index = open(os.path.join(root, 'dist/index.html')).read()


def slice_between(start_marker, end_marker):
    i = index.index(start_marker)
    j = index.index(end_marker, i) + len(end_marker)
    return index[i:j]


sidenav = slice_between('<aside class="sidenav"', '</aside>')
topnav = slice_between('<nav class="topnav"', '</nav>')
bottomnav = slice_between('<nav id="bottomnav"', '</nav>')
backdrop = slice_between('<div id="sidenav-backdrop"', '</div>')

# ---------------------------------------------------------------- mock content
POSTERS = [
    ('Dune: Part Two', '2024 · Sci-Fi', '#c98a4b', '#3a2a1c'),
    ('Oppenheimer', '2023 · Drama', '#8d8f96', '#20222a'),
    ('The Wild Robot', '2024 · Animation', '#5fae8c', '#16302a'),
    ('Godzilla x Kong', '2024 · Action', '#b4553f', '#2a1512'),
    ('Poor Things', '2023 · Comedy', '#b06f9e', '#2b1a29'),
    ('Blade Runner 2049', '2017 · Sci-Fi', '#d8a45c', '#241d16'),
    ('Arrival', '2016 · Sci-Fi', '#6f8fb3', '#1a2129'),
    ('Interstellar', '2014 · Adventure', '#7d8fa8', '#171b22'),
]


def poster_svg(title, meta, c1, c2):
    initial = (title.strip() or ' ')[0]
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="316" height="474">'
        f'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/>'
        '</linearGradient></defs>'
        '<rect width="316" height="474" fill="url(#g)"/>'
        f'<text x="24" y="300" font-family="Helvetica,Arial" font-size="150" font-weight="700" '
        f'fill="rgba(255,255,255,0.16)">{initial}</text>'
        f'<text x="24" y="410" font-family="Helvetica,Arial" font-size="26" font-weight="700" fill="#fff">{title}</text>'
        f'<text x="24" y="440" font-family="Helvetica,Arial" font-size="18" fill="rgba(255,255,255,0.72)">{meta}</text>'
        '</svg>'
    )


def card(title, meta, c1, c2):
    poster = poster_svg(title, meta, c1, c2)
    return f"""          <article class="card-item">
            <div class="card-item__poster">
              <img src="data:image/svg+xml;utf8,{poster}" alt="" />
              <span class="card-item__badge">Movie</span>
              <button class="card-item__like" type="button" aria-label="Like">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
              </button>
            </div>
            <div class="card-item__body">
              <div class="card-item__title">{title}</div>
              <div class="card-item__meta">{meta}</div>
            </div>
          </article>"""


def row(title, items):
    return f"""        <section class="row">
          <h2 class="row__title">{title}</h2>
          <div class="row__scroller">
{chr(10).join(items)}
          </div>
        </section>"""


HERO_LOGO = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="120">'
    '<text x="0" y="86" font-family="Helvetica,Arial" font-size="86" font-weight="700" '
    'letter-spacing="6" fill="#ffffff">INTERSTELLAR</text>'
    '<text x="4" y="114" font-family="Helvetica,Arial" font-size="20" letter-spacing="10" '
    'fill="rgba(255,255,255,0.62)">A FILM BY C. NOLAN</text>'
    '</svg>'
)

HERO_ART = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="860">'
    '<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1">'
    '<stop offset="0" stop-color="#20304a"/><stop offset=".55" stop-color="#101826"/>'
    '<stop offset="1" stop-color="#05070c"/></linearGradient>'
    '<radialGradient id="p" cx=".72" cy=".3" r=".5">'
    '<stop offset="0" stop-color="#d9c9a3" stop-opacity=".55"/>'
    '<stop offset="1" stop-color="#d9c9a3" stop-opacity="0"/></radialGradient></defs>'
    '<rect width="1920" height="860" fill="url(#s)"/>'
    '<rect width="1920" height="860" fill="url(#p)"/>'
    '<circle cx="1382" cy="258" r="150" fill="#0e1420"/>'
    '<circle cx="1382" cy="258" r="150" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="6"/>'
    '</svg>'
)

hero_desktop = f"""      <div class="browse__hero">
        <div class="hero">
          <div class="hero__media">
            <img src="data:image/svg+xml;utf8,{HERO_ART}" alt="" />
          </div>
          <div class="hero__content">
            <span class="hero__badge">Movie</span>
            <img class="hero__logo" src="data:image/svg+xml;utf8,{HERO_LOGO}" alt="" aria-hidden="true" />
            <div class="hero__meta"><span>★ 8.7</span><span>2014</span><span>169 min</span><span>Adventure</span></div>
            <p class="hero__overview">
              With Earth's farmland failing, a former NASA pilot leads a small crew through a
              wormhole near Saturn in search of a new home for humanity.
            </p>
            <div class="hero__actions">
              <button class="btn btn--primary" type="button">Watch together</button>
              <button class="btn btn--ghost" type="button">Details</button>
            </div>
          </div>
        </div>
      </div>"""

hero_phone = hero_desktop.replace('hero__meta"><span>★ 8.7</span>', 'hero__meta"><span>8.7</span>')

cards = [card(t, m, a, b) for t, m, a, b in POSTERS]
rows = row('Trending now', cards[:5]) + '\n' + row('Because you liked Sci-Fi', cards[3:8])

MOBILE_THEME = ''
DESKTOP_THEME = ''

PAGE_CSS = """    <style>
      /* Review-page chrome only: every component is the SHIPPED markup + CSS. */
      body { padding: 26px var(--page-pad) 90px; }
      .rv { max-width: 1920px; margin: 0 auto; display: grid; gap: 34px; }
      .rv__head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
      .rv__title { margin: 0; font-size: 22px; }
      .rv__hint { color: var(--text-muted); font-size: 13px; line-height: 1.6; margin: 6px 0 0; max-width: 90ch; }
      .rv__label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-muted); margin: 0 0 12px; }
      .rv__row { display: flex; gap: 26px; flex-wrap: wrap; align-items: flex-start; }
      .rv__phone { width: 390px; height: 844px; border-radius: 34px; border: 1px solid var(--border);
        box-shadow: var(--shadow-3); overflow: hidden; background: var(--bg); flex: 0 0 auto; }
      .rv__phone iframe { width: 100%; height: 100%; border: 0; display: block; }
      .rv__tooltip .card-preview { position: static; }
      .rv__panel { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-soft); padding: 18px; }
      .rv__seg { display: flex; gap: 8px; flex-wrap: wrap; }
      .rv__stage { position: relative; border-radius: var(--radius-lg); overflow: hidden; background: var(--bg-elev); }
    </style>"""

DESKTOP_BODY = f"""      {hero_desktop}
      <div class="browse__rows">
{rows}
      </div>"""

TOOLTIP = """      <div class="rv__tooltip">
        <div class="card-preview">
          <div class="card-preview__media"><img src="data:image/svg+xml;utf8,ART" alt="" /></div>
          <div class="card-preview__body">
            <div class="card-preview__text">
              <img class="card-preview__logo" src="data:image/svg+xml;utf8,TIPLOGO" alt="" aria-hidden="true" />
              <div class="card-preview__title is-title-hidden">Interstellar</div>
              <div class="card-preview__meta">★ 8.7 · 2014 · 169 min · Adventure</div>
              <p class="card-preview__overview">A former NASA pilot leads a crew through a wormhole near Saturn in search of a new home for humanity.</p>
            </div>
            <button class="card-preview__sound is-on" type="button" aria-pressed="true" aria-label="Trailer sound: on">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
            </button>
          </div>
        </div>
      </div>"""

DETAIL = """      <div class="rv__panel detail" style="max-width: 560px">
        <div class="detail__top">
          <img class="detail__poster" src="data:image/svg+xml;utf8,DETPOSTER" alt="" />
          <div class="detail__info">
            <img class="detail__logo" src="data:image/svg+xml;utf8,TIPLOGO" alt="" aria-hidden="true" />
            <div class="detail__title is-title-hidden">Interstellar</div>
            <div class="detail__meta"><span>★ 8.7</span><span>2014</span><span>169 min</span><span>Adventure</span></div>
            <p class="detail__overview">With Earth's farmland failing, a former NASA pilot leads a small crew through a wormhole near Saturn.</p>
          </div>
        </div>
        <div class="detail__section">
          <p class="detail__label">Season</p>
          <div class="detail__seasons">
            <button class="chip chip--active" type="button">Season 1</button>
            <button class="chip" type="button">Season 2</button>
          </div>
          <p class="detail__label">Episode</p>
          <div class="detail__episodes">EPISODES</div>
        </div>
        <div class="detail__actions">
          <button class="btn btn--primary" type="button">Watch together</button>
        </div>
      </div>"""


def episodes():
    out = []
    for i in range(1, 13):
        cls = 'ep-btn' + (' ep-btn--watched' if i <= 3 else '')
        out.append(f'<button class="{cls}" type="button">{i}</button>')
    return ''.join(out)


tip_logo = TIPLOGO = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="54">'
    '<text x="0" y="40" font-family="Helvetica,Arial" font-size="38" font-weight="700" '
    'letter-spacing="2" fill="#f1f1f1">INTERSTELLAR</text></svg>'
)
det_poster = poster_svg('Interstellar', '2014 · Adventure', '#7d8fa8', '#171b22')
tip_art = poster_svg(' ', '', '#20304a', '#05070c')
tiny_poster = poster_svg('Interstellar', '', '#7d8fa8', '#171b22')

DESKTOP_SECTION = f"""    <section>
      <p class="rv__label">Desktop / TV — hero banner (title logo), rows, tooltip, details</p>
      <div class="browse" style="border-radius: var(--radius-lg); overflow: hidden; border: 1px solid var(--border)">
        <nav class="topnav" style="position: static">
          <div class="brand__name" style="font-weight:700;font-size:17px;letter-spacing:-.02em">WatchParty</div>
          <div class="topnav__search">
            <span class="topnav__search-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></span>
            <input class="topnav__search-input" placeholder="Search movies, series and anime…" />
          </div>
          <div class="topnav__right"><button class="btn btn--sm btn--ghost" type="button">Friends</button></div>
        </nav>
{DESKTOP_BODY}
      </div>
    </section>

    <section>
      <p class="rv__label">Hover tooltip (pinned open) + detail card</p>
      <div class="rv__row">
{TOOLTIP}
{DETAIL.replace('EPISODES', episodes())}
      </div>
    </section>"""

DESKTOP_SECTION = DESKTOP_SECTION.replace('ART', tip_art).replace('TIPLOGO', tip_logo).replace('DETPOSTER', det_poster)


def build_frame(theme, with_content):
    content = ''
    if with_content:
        content = f"""      <main id="home" class="home">
        <div class="browse">
{hero_phone}
          <div class="browse__rows">
{row('Trending now', cards[:5])}
          </div>
        </div>
      </main>"""
    return f"""<!doctype html>
<html lang="en" data-theme="{theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WatchParty — phone frame ({theme})</title>
    <link rel="stylesheet" href="../dist/css/style.css" />
    <link rel="stylesheet" href="../dist/css/catalog.css" />
    <link rel="stylesheet" href="../dist/css/social.css" />
  </head>
  <body>
  <div class="app-shell">
{sidenav}
    <div class="app-shell__main">
{topnav}
{content}
{bottomnav}
    </div>
  </div>
{backdrop}
  </body>
</html>
"""


preview = f"""<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WatchParty — design review</title>
    <link rel="stylesheet" href="../dist/css/style.css" />
    <link rel="stylesheet" href="../dist/css/catalog.css" />
    <link rel="stylesheet" href="../dist/css/social.css" />
{PAGE_CSS}
  </head>
  <body>
    <div class="rv">
      <div class="rv__head">
        <div>
          <h1 class="rv__title">Design review — hero logos, tooltip, responsive scale</h1>
          <p class="rv__hint">
            Shipped markup + shipped CSS. The banner, tooltip and detail card use the SAME
            components the app renders; the phone frames below are real viewports (390×844), so the
            <code>≤720px</code> rules apply. Click into a frame to scroll it. Title art comes from
            TMDB in the app — the wordmarks here are stand-ins.
          </p>
        </div>
        <div class="rv__seg">
          <button class="logo-btn btn btn--sm" data-theme-set="dark" type="button">Dark</button>
          <button class="logo-btn btn btn--sm" data-theme-set="light" type="button">Light</button>
        </div>
      </div>

      <section>
        <p class="rv__label">Phone (390×844) — feed, and the “More” sheet</p>
        <div class="rv__row">
          <div class="rv__phone"><iframe id="phone-a" title="phone feed" src="design-frame.html"></iframe></div>
          <div class="rv__phone"><iframe id="phone-b" title="phone sheet" src="design-frame.html?sheet=1"></iframe></div>
        </div>
      </section>

{DESKTOP_SECTION}
    </div>

    <script>
      // The phone frames are separate documents: theme + the More sheet are
      // driven from here so one review page can show every state.
      const params = new URLSearchParams(location.search);
      const frames = [document.getElementById('phone-a'), document.getElementById('phone-b')];
      function paint(theme) {{
        document.documentElement.setAttribute('data-theme', theme);
        frames.forEach((f) => {{
          try {{ f.contentDocument.documentElement.setAttribute('data-theme', theme); }} catch (_) {{}}
        }});
        document.querySelectorAll('[data-theme-set]').forEach((b) => {{
          b.classList.toggle('btn--primary', b.dataset.themeSet === theme);
        }});
      }}
      document.querySelectorAll('[data-theme-set]').forEach((b) =>
        b.addEventListener('click', () => paint(b.dataset.themeSet))
      );
      window.addEventListener('load', () => {{
        const theme = params.get('theme') || 'dark';
        paint(theme);
        // Frame B shows the sheet open (the app toggles body.menu-open).
        try {{
          const d = document.getElementById('phone-b').contentDocument;
          d.body.classList.add('menu-open');
          const bg = d.getElementById('sidenav-backdrop');
          if (bg) bg.hidden = false;
          const more = d.getElementById('bottomnav-more');
          if (more) more.setAttribute('aria-expanded', 'true');
        }} catch (_) {{}}
      }});
    </script>
  </body>
</html>
"""

out_frame = os.path.join(root, 'scripts/design-frame.html')
out_preview = os.path.join(root, 'scripts/design-preview.html')
open(out_frame, 'w').write(build_frame('dark', True))
open(out_preview, 'w').write(preview)
print('wrote', out_frame)
print('wrote', out_preview)
