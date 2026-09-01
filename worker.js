// SabelaLogic Dealer OS - AutoShow Bloemfontein
// Cloudflare Worker serving the full funnel: landing -> stock -> test drive /
// trade-in evaluation booking -> WhatsApp handoff -> appointment written to D1
//
// DEPLOY (run from Termux or Codespaces, not from Claude):
//   wrangler d1 execute dealer_os --remote --file=./dealer_os_schema.sql   (already done via API today)
//   wrangler deploy
//
// wrangler.toml needs:
//   name = "autoshow-dealer-os"
//   main = "worker.js"
//   compatibility_date = "2026-08-27"
//   [[d1_databases]]
//   binding = "DB"
//   database_name = "dealer_os"
//   database_id = "f0263076-679a-486a-abe7-233db65620ac"

const DEALER_ID = "autoshow-bloemfontein";
const WHATSAPP_NUMBER = "27761021676"; // AutoShow's real WhatsApp number

// R2 key of the real AutoShow logo (transparent background), same
// "DealerOS images/" folder as the hero videos. Leave "" to fall back to
// the generated text wordmark instead.
const LOGO_KEY = "DealerOS images/269591182_104228588833703_8728799146245725977_n-removebg-preview.png";

// R2 keys of videos to autoplay muted/looped behind the hero as a
// crossfading slideshow at reduced opacity. These live inside the
// "DealerOS images/" folder in the autoshow-vehicle-photos bucket, so the
// prefix is part of the key - R2 "folders" are just key prefixes, there's
// no real subfolder. Leave the array empty to fall back to the real
// floor-stock photo slideshow instead.
const HERO_VIDEO_KEYS = [
  "DealerOS images/500930063_1788189877930701.mp4",
  "DealerOS images/691950586_1788189700216226.mp4",
];

// AutoShow brand: red/black/blue/white. Keep these exact values across
// future builds/redesigns - layout and features can change, these can't.
const BRAND = {
  paper: "#F6F6F8",
  ink: "#121212",
  inkSoft: "#5C5D63",
  coral: "#E31E2B", // red
  gold: "#2B63EB", // blue (bright accent)
  sage: "#123E91", // blue (deep, primary actions)
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/stock") return jsonResponse(await getStock(env));
    if (path === "/api/leads") return jsonResponse(await getLeads(env));
    if (path === "/api/appointments" && request.method === "POST") {
      return handleBookAppointment(request, env);
    }
    if (path.startsWith("/vehicle/")) return renderVehiclePage(path, env, url);
    if (path === "/test-drive") return renderBookingPage("test_drive", url, env);
    if (path === "/evaluate") return renderBookingPage("valuation", url, env);
    if (path === "/dashboard") return renderDashboard(env);
    if (path === "/sitemap.xml") return renderSitemap(env, url);
    if (path === "/robots.txt") return renderRobots(url);
    if (path.startsWith("/photos/")) return servePhoto(request, path, env);
    if (path === "/api/photo-info") return servePhotoInfo(url, env);

    return renderLandingPage(env);
  },
};

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function getStock(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM stock WHERE dealer_id = ? AND status != 'sold' ORDER BY retail_price DESC"
  ).bind(DEALER_ID).all();
  return results;
}

async function getLeads(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM leads WHERE dealer_id = ? ORDER BY usability_score DESC"
  ).bind(DEALER_ID).all();
  return results;
}

async function getStockItem(stockId, env) {
  return env.DB.prepare("SELECT * FROM stock WHERE stock_id = ? AND dealer_id = ?")
    .bind(stockId, DEALER_ID).first();
}

async function servePhoto(request, path, env) {
  // Serves a real customer/vehicle photo (or the hero background video)
  // uploaded to R2 at /photos/<key>. Photos and video land in the bucket
  // via the Cloudflare dashboard (R2 -> autoshow-vehicle-photos -> Upload)
  // - no code change needed to add new floor-stock shots, just reference
  // the key in D1's photo_urls field or in HERO_VIDEO_KEY.
  const key = decodeURIComponent(path.replace("/photos/", ""));

  // Video playback needs Range support - browsers won't play (or can't
  // seek) an R2 object served as one flat 200 response. R2 throws if the
  // requested offset is at/beyond the object's actual size, so check the
  // size first (via head) and answer out-of-range requests with a clean
  // 416 instead of letting that throw into a 500.
  const rangeHeader = request.headers.get("range");
  const rangeMatch = rangeHeader && rangeHeader.match(/^bytes=(\d+)-(\d*)$/);

  if (rangeMatch) {
    const head = await env.PHOTOS.head(key);
    if (!head) return new Response("Photo not found", { status: 404 });

    const size = head.size;
    const offset = Number(rangeMatch[1]);
    const end = rangeMatch[2] ? Number(rangeMatch[2]) : size - 1;
    if (offset >= size || end < offset) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }

    const length = Math.min(end, size - 1) - offset + 1;
    const object = await env.PHOTOS.get(key, { range: { offset, length } });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("accept-ranges", "bytes");
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${size}`);
    return new Response(object.body, { status: 206, headers });
  }

  const object = await env.PHOTOS.get(key);
  if (!object) return new Response("Photo not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("accept-ranges", "bytes");
  return new Response(object.body, { headers });
}

async function servePhotoInfo(url, env) {
  // Temporary read-only diagnostic - lets us see what R2 actually has for a
  // given key (size, content-type, whether it exists at all) without
  // needing to interpret browser video-playback behavior secondhand.
  // GET /api/photo-info?key=<r2-key>
  const key = url.searchParams.get("key");
  if (!key) return jsonResponse({ error: "missing ?key=" }, 400);

  const head = await env.PHOTOS.head(key);
  if (!head) return jsonResponse({ exists: false, key });

  return jsonResponse({
    exists: true,
    key,
    size: head.size,
    contentType: (head.httpMetadata && head.httpMetadata.contentType) || null,
    uploaded: head.uploaded,
    etag: head.httpEtag,
  });
}

async function getSimilarVehicles(item, env) {
  // Free "you might also like": same price band (+/- 20%), excluding itself.
  const low = item.retail_price * 0.8;
  const high = item.retail_price * 1.2;
  const { results } = await env.DB.prepare(
    `SELECT * FROM stock WHERE dealer_id = ? AND stock_id != ? AND status != 'sold'
     AND retail_price BETWEEN ? AND ? LIMIT 3`
  ).bind(DEALER_ID, item.stock_id, low, high).all();
  return results;
}

async function handleBookAppointment(request, env) {
  const body = await request.json();
  const { appointment_type, customer_name, customer_phone, stock_id, scheduled_time, notes } = body;

  if (!customer_name || !customer_phone) {
    return jsonResponse({ error: "Name and phone are required" }, 400);
  }

  const appointmentId = "appt-" + crypto.randomUUID().slice(0, 12);

  await env.DB.prepare(
    `INSERT INTO appointments
     (appointment_id, dealer_id, stock_id, appointment_type, customer_name,
      customer_phone, scheduled_time, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
  ).bind(
    appointmentId, DEALER_ID, stock_id || null, appointment_type,
    customer_name, customer_phone, scheduled_time || null, notes || ""
  ).run();

  return jsonResponse({ success: true, appointment_id: appointmentId });
}

// ---------------------------------------------------------------------------
// Shared layout helpers
// ---------------------------------------------------------------------------

function logoMark() {
  if (LOGO_KEY) {
    return `<a href="/" class="logo-link" aria-label="AutoShow Bloemfontein"><img class="logo-image" src="/photos/${encodeURIComponent(LOGO_KEY)}" alt="AutoShow Bloemfontein"></a>`;
  }
  // Fallback if LOGO_KEY is ever cleared: re-angles the gradient sweep on
  // every request so the wordmark never renders as a flat, identical
  // bitmap twice - a lightweight generative treatment needing no image.
  const angle = Math.floor(Math.random() * 360);
  return `<a href="/" class="logo-mark" style="--logo-angle:${angle}deg;">AUTOSHOW<span class="dot">.</span></a>`;
}

function pageShell(title, bodyContent, extraHead = "", og = {}) {
  const ogTitle = og.ogTitle || `${title} | AutoShow Bloemfontein`;
  const ogDescription = og.ogDescription || "Quality used vehicles in Bloemfontein. Book a test drive or trade in your car today.";
  const ogUrl = og.ogUrl || "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="${ogDescription}">
<title>${title} | AutoShow Bloemfontein</title>
<!-- Free Open Graph tags - WhatsApp/Facebook link previews without any paid tool -->
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDescription}">
<meta property="og:type" content="website">
${ogUrl ? `<meta property="og:url" content="${ogUrl}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* Accessibility: visible keyboard focus, respects reduced motion - free, no vendor needed */
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible {
    outline: 3px solid var(--coral); outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  .skip-link {
    position: absolute; left: -9999px; top: 0; background: var(--ink); color: var(--paper);
    padding: 10px 16px; z-index: 100; border-radius: 0 0 8px 0;
  }
  .skip-link:focus { left: 0; }
  :root {
    --paper: ${BRAND.paper}; --ink: ${BRAND.ink}; --ink-soft: ${BRAND.inkSoft};
    --coral: ${BRAND.coral}; --gold: ${BRAND.gold}; --sage: ${BRAND.sage};
    --line: rgba(18,18,18,0.10);
    --glass: rgba(255,255,255,0.6); --glass-border: rgba(255,255,255,0.7);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: 'Manrope', sans-serif; color: var(--ink);
    background:
      radial-gradient(circle at 15% 8%, rgba(43,99,235,0.12), transparent 45%),
      radial-gradient(circle at 90% 20%, rgba(227,30,43,0.10), transparent 40%),
      var(--paper);
    min-height: 100vh; padding-bottom: 60px;
  }
  header {
    max-width: 1100px; margin: 0 auto; padding: 20px; display: flex;
    justify-content: space-between; align-items: center;
    position: sticky; top: 0; z-index: 20;
    background: rgba(246,246,248,0.85); backdrop-filter: blur(14px);
    border-bottom: 1px solid transparent; transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  header.scrolled { border-bottom-color: var(--line); box-shadow: 0 4px 20px rgba(18,18,18,0.05); }
  nav a {
    font-family: 'JetBrains Mono', monospace; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--ink-soft); text-decoration: none; margin-left: 20px;
    transition: color 0.15s ease; padding-bottom: 2px; border-bottom: 1px solid transparent;
  }
  nav a:hover { color: var(--coral); border-bottom-color: var(--coral); }
  main { max-width: 1100px; margin: 0 auto; padding: 0 20px; }
  h1 { font-family: 'Fraunces', serif; font-weight: 600; letter-spacing: -0.015em; }
  h2 { font-family: 'Fraunces', serif; font-weight: 600; letter-spacing: -0.01em; }
  .eyebrow {
    font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--coral); font-weight: 600; margin-bottom: 10px;
  }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; font-family: 'Manrope', sans-serif;
    font-weight: 700; font-size: 14px; padding: 13px 24px; border-radius: 12px;
    text-decoration: none; border: none; cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn-primary { background: var(--sage); color: white; box-shadow: 0 4px 14px rgba(18,62,145,0.3); }
  .btn-primary:hover { box-shadow: 0 6px 18px rgba(18,62,145,0.4); }
  .btn-whatsapp { background: #22c55e; color: white; box-shadow: 0 4px 14px rgba(34,197,94,0.28); }
  .btn-whatsapp:hover { box-shadow: 0 6px 18px rgba(34,197,94,0.38); }
  .btn-outline { background: var(--glass); color: var(--ink); border: 1px solid var(--line); }
  .btn-outline:hover { border-color: var(--ink-soft); background: rgba(255,255,255,0.85); }
  .card {
    background: var(--glass); border: 1px solid var(--glass-border); backdrop-filter: blur(10px);
    border-radius: 18px; padding: 22px; margin-bottom: 14px;
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
  }
  .card:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(18,18,18,0.07); border-color: rgba(255,255,255,0.9); }
  .vehicle-image-placeholder {
    aspect-ratio: 16/9; border-radius: 12px; margin-bottom: 16px;
    background:
      repeating-linear-gradient(135deg, rgba(18,18,18,0.03) 0px, rgba(18,18,18,0.03) 2px, transparent 2px, transparent 14px),
      linear-gradient(135deg, rgba(227,30,43,0.08), rgba(43,99,235,0.08));
    display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 6px;
    border: 1px solid var(--line);
  }
  .vehicle-image-placeholder svg { opacity: 0.35; width: 40px; height: 40px; }
  .vehicle-image-placeholder span {
    font-family: 'JetBrains Mono', monospace; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--ink-soft); opacity: 0.6;
  }
  input, select, textarea {
    width: 100%; padding: 13px 14px; border-radius: 10px; border: 1px solid var(--line);
    background: rgba(255,255,255,0.7); font-family: 'Manrope', sans-serif; font-size: 15px; margin-bottom: 12px;
    transition: border-color 0.15s ease;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--sage); }
  label { font-family: 'JetBrains Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-soft); display: block; margin-bottom: 6px; }

  /* Real AutoShow logo mark (transparent PNG from R2). */
  .logo-link { display: inline-flex; align-items: center; transition: transform 0.15s ease, opacity 0.15s ease; }
  .logo-link:hover { transform: translateY(-1px); opacity: 0.9; }
  .logo-image { display: block; height: 40px; width: auto; }

  /* Generated brand mark - an ink wordmark with a coral gleam that sweeps
     across it, re-angled per page load. Coral stays the only accent, same
     as the static dot always was - this is motion, not a new palette.
     Fallback only, used when LOGO_KEY is empty. */
  .logo-mark {
    font-family: 'Fraunces', serif; font-weight: 700; font-size: 21px; text-decoration: none;
    letter-spacing: -0.01em; display: inline-block; background-size: 220% auto; color: var(--ink);
    background-image: linear-gradient(var(--logo-angle, 100deg), var(--ink) 0%, var(--ink) 42%, var(--coral) 50%, var(--ink) 58%, var(--ink) 100%);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    animation: logoShine 6s ease-in-out infinite;
  }
  .logo-mark .dot { -webkit-text-fill-color: var(--coral); color: var(--coral); }
  @keyframes logoShine { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
  @media (prefers-reduced-motion: reduce) { .logo-mark { animation: none; } }

  /* Scroll-reveal: sections and cards ease in as they enter view, so
     nothing on the page reads as static once you start scrolling. */
  .reveal { opacity: 0; transform: translateY(24px); transition: opacity 0.7s ease, transform 0.7s ease; }
  .reveal.in { opacity: 1; transform: translateY(0); }
  @media (prefers-reduced-motion: reduce) { .reveal { opacity: 1; transform: none; transition: none; } }

  /* 3D pointer tilt for cards. */
  .tilt-card { transform-style: preserve-3d; will-change: transform; transition: transform 0.15s ease-out, box-shadow 0.18s ease, border-color 0.18s ease; }

  .pulse-dot { display: inline-block; animation: pulseDot 2.4s ease-in-out infinite; }
  @keyframes pulseDot { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .pulse-dot { animation: none; } }

  /* Parallax / slideshow hero stage - real floor-stock photos crossfading
     with a slow Ken Burns drift, plus a subtle pointer-driven 3D tilt. */
  .hero-stage.has-photos {
    position: relative; overflow: hidden; border-radius: 26px; min-height: 480px;
    display: flex; align-items: flex-end; margin-top: 10px; isolation: isolate; perspective: 1000px;
  }
  .hero-bg { position: absolute; inset: -4%; z-index: 0; transition: transform 0.25s ease-out; }
  .hero-video {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0;
  }
  .hero-slide {
    position: absolute; inset: 0; background-size: cover; background-position: center;
    opacity: 0; animation: kenburns 16s ease-in-out infinite; will-change: transform, opacity;
    transition: opacity 1.8s ease;
  }
  .hero-slide.active { opacity: 1; z-index: 1; }
  @keyframes kenburns {
    0% { transform: scale(1.04) translate(0, 0); }
    50% { transform: scale(1.16) translate(-1.4%, 1.2%); }
    100% { transform: scale(1.04) translate(0, 0); }
  }
  .hero-overlay {
    position: absolute; inset: 0; z-index: 1;
    background: linear-gradient(180deg, rgba(18,18,18,0.10) 0%, rgba(18,18,18,0.5) 72%, rgba(18,18,18,0.78) 100%);
  }
  .hero-content { position: relative; z-index: 2; padding: 44px clamp(20px,4vw,48px); color: var(--paper); width: 100%; }
  .hero-content .eyebrow { color: var(--gold); }
  .hero-content h1 { color: var(--paper); }
  .hero-content p { color: rgba(246,246,248,0.88); }
  .hero-content .stat-strip span { color: rgba(246,246,248,0.78); }
  @media (prefers-reduced-motion: reduce) {
    .hero-slide { animation: none; transition: opacity 0.4s ease; }
    .hero-bg { transition: none !important; transform: none !important; }
  }
  ${extraHead}
</style>
<noscript><style>.reveal, .materialize { opacity: 1 !important; transform: none !important; filter: none !important; }</style></noscript>
<script>
  window.addEventListener('scroll', () => {
    const h = document.querySelector('header');
    if (h) h.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.addEventListener('DOMContentLoaded', () => {
    // Scroll-reveal.
    const revealEls = document.querySelectorAll('.reveal');
    if (!prefersReducedMotion && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
      revealEls.forEach((el) => io.observe(el));
    } else {
      revealEls.forEach((el) => el.classList.add('in'));
    }

    // Pointer-driven 3D tilt on cards (desktop mouse only).
    if (!prefersReducedMotion) {
      document.querySelectorAll('.tilt-card').forEach((card) => {
        card.addEventListener('pointermove', (e) => {
          if (e.pointerType && e.pointerType !== 'mouse') return;
          const r = card.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width - 0.5;
          const py = (e.clientY - r.top) / r.height - 0.5;
          card.style.transform = 'perspective(900px) rotateX(' + (-py * 6) + 'deg) rotateY(' + (px * 8) + 'deg) translateY(-2px)';
        });
        card.addEventListener('pointerleave', () => { card.style.transform = ''; });
      });
    }

    // Hero: crossfading slideshow of real floor-stock photos + pointer parallax.
    const stage = document.getElementById('hero-stage');
    if (stage) {
      const video = document.getElementById('hero-video');
      if (video) {
        if (prefersReducedMotion) {
          video.pause();
          video.removeAttribute('autoplay');
        } else {
          video.play().catch(() => {});
        }
      }
      const slides = stage.querySelectorAll('.hero-slide');
      if (slides.length > 1 && !prefersReducedMotion) {
        let i = 0;
        setInterval(() => {
          slides[i].classList.remove('active');
          i = (i + 1) % slides.length;
          slides[i].classList.add('active');
        }, 4800);
      }
      if (!prefersReducedMotion) {
        stage.addEventListener('pointermove', (e) => {
          const r = stage.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width - 0.5;
          const py = (e.clientY - r.top) / r.height - 0.5;
          const bg = stage.querySelector('.hero-bg');
          if (bg) bg.style.transform = 'translate3d(' + (px * -16).toFixed(1) + 'px,' + (py * -12).toFixed(1) + 'px,0) scale(1.02)';
        });
        stage.addEventListener('pointerleave', () => {
          const bg = stage.querySelector('.hero-bg');
          if (bg) bg.style.transform = '';
        });
      }
    }
  });
</script>
</head>
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
<header>
  ${logoMark()}
  <nav aria-label="Main navigation">
    <a href="/#stock">Stock</a>
    <a href="/evaluate">Sell / Trade-In</a>
    <a href="https://wa.me/${WHATSAPP_NUMBER}">WhatsApp</a>
  </nav>
</header>
<main id="main-content">${bodyContent}</main>
<footer style="max-width:1100px; margin:40px auto 0; padding:20px; text-align:center; font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--ink-soft);">
  AutoShow Bloemfontein &middot; 190 Oliver Tambo Road, Oranjesig &middot;
  <a href="https://wa.me/${WHATSAPP_NUMBER}" style="color:var(--coral);">WhatsApp ${WHATSAPP_NUMBER}</a>
  &middot; <a href="https://www.facebook.com/autoshowbloemfontein" style="color:var(--coral);">Read our reviews on Facebook</a>
</footer>
</body>
</html>`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

async function renderLandingPage(env) {
  const stock = await getStock(env);

  const carIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 17h14M5 17a2 2 0 100 4 2 2 0 000-4zm14 0a2 2 0 100 4 2 2 0 000-4zM5 17V9l2-5h10l2 5v8"/></svg>`;

  const vehicleMedia = (s) => s.photo_urls
    ? `<a href="/vehicle/${s.stock_id}"><img src="${s.photo_urls}" alt="${s.year} ${s.make} ${s.model}" loading="lazy" style="width:100%; aspect-ratio:16/9; object-fit:cover; border-radius:12px; margin-bottom:16px; display:block;"></a>`
    : `<a href="/vehicle/${s.stock_id}" style="text-decoration:none;"><div class="vehicle-image-placeholder">${carIconSvg}<span>Photo coming soon</span></div></a>`;

  const mileageText = (s) => s.mileage ? `${s.mileage.toLocaleString()} km &middot; ` : "";

  // Real floor-stock photos, shuffled - fuel the "From the Floor" gallery
  // strip below with actual random views of the lot.
  const heroPhotos = [...new Set(stock.map(s => s.photo_urls).filter(Boolean))];
  for (let i = heroPhotos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [heroPhotos[i], heroPhotos[j]] = [heroPhotos[j], heroPhotos[i]];
  }
  const heroSlides = heroPhotos.slice(0, 8);

  // Buckets/keys the search form below matches against - client-side only,
  // no new API needed since the whole stock list is already on the page.
  const priceBucket = (price) => price < 150000 ? "low" : price < 300000 ? "mid" : "high";
  const uniqueMakes = [...new Set(stock.map(s => s.make).filter(Boolean))].sort();

  const stockCards = stock.map(s => `
    <div class="card tilt-card reveal stock-card" data-make="${(s.make || "").toLowerCase()}" data-price="${priceBucket(Number(s.retail_price))}" data-transmission="${(s.transmission || "").toLowerCase()}">
      ${vehicleMedia(s)}
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
        <div>
          <div style="font-weight:700; font-size:17px;"><a href="/vehicle/${s.stock_id}" style="color:inherit; text-decoration:none;">${s.year} ${s.make} ${s.model}</a></div>
          <div style="font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--ink-soft); margin-top:4px;">
            ${mileageText(s)}${s.transmission} &middot; ${s.fuel_type}
          </div>
        </div>
        <span style="font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:700; padding:3px 9px; border-radius:20px; text-transform:uppercase; background:${s.status === 'available' ? 'rgba(18,62,145,0.16)' : 'rgba(227,30,43,0.14)'}; color:${s.status === 'available' ? '#123E91' : '#8C1620'};">${s.status}</span>
      </div>
      <div style="font-family:'Fraunces',serif; font-weight:600; font-size:22px; color:var(--sage); margin:10px 0;">R ${Number(s.retail_price).toLocaleString()}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a href="/test-drive?stock_id=${s.stock_id}" class="btn btn-primary">Book Test Drive</a>
        <a href="https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi, I'm interested in the ${s.year} ${s.make} ${s.model} - is it still available?`)}" class="btn btn-whatsapp">WhatsApp Us</a>
      </div>
    </div>
  `).join("");

  // Full-bleed hero (same hero-stage the rest of the site already ships).
  // Videos in HERO_VIDEO_KEYS play as a silent, crossfading, reduced-opacity
  // background slideshow; falls back to the real floor-stock photo
  // slideshow if no video keys are configured.
  const heroVideoSlides = HERO_VIDEO_KEYS.map((key, i) => `
    <video class="hero-video-slide${i === 0 ? " active" : ""}" muted loop playsinline preload="${i === 0 ? "auto" : "none"}"${i === 0 && heroSlides[0] ? ` poster="${heroSlides[0]}"` : ""}>
      <source src="/photos/${encodeURIComponent(key)}" type="video/mp4">
    </video>
  `).join("");

  const heroMedia = HERO_VIDEO_KEYS.length
    ? `<div class="hero-video-stack">${heroVideoSlides}</div>`
    : heroSlides.length
      ? `<div class="hero-bg">
           ${heroSlides.map((src, i) => `<div class="hero-slide${i === 0 ? ' active' : ''}" style="background-image:url('${src}'); animation-delay:${(i * 0.6).toFixed(1)}s;"></div>`).join("")}
         </div>`
      : "";

  const heroInner = `
      <div class="eyebrow materialize" style="animation-delay:0.1s;">Bloemfontein &middot; Quality Used Vehicles</div>
      <h1 class="materialize" style="animation-delay:0.25s; font-size:clamp(32px,6vw,50px); margin:0 0 14px; line-height:1.08;">Find your next car,<br>book a test drive today.</h1>
      <p class="materialize" style="animation-delay:0.4s; font-size:16px; max-width:50ch; line-height:1.6;">Real stock, updated daily. Search below and book a time that works for you.</p>
  `;

  // The diagonal wash behind the hero is a soft brand-colour gradient, not a
  // flat shape - it bleeds out past the hero's own edges, which are masked
  // to dissolve rather than clipped to a hard box.
  const hero = heroMedia
    ? `<div class="hero-wrap">
        <div class="diagonal-accent materialize" style="animation-delay:0s;" aria-hidden="true"></div>
        <div class="hero-stage has-photos" id="hero-stage" style="min-height:420px;">
          ${heroMedia}
          <div class="hero-overlay"></div>
          <div class="hero-content" style="padding-bottom:88px;">${heroInner}</div>
        </div>
      </div>`
    : `<div class="hero-wrap" style="padding:44px 0 4px; position:relative;">
        <div class="diagonal-accent materialize" style="animation-delay:0s;" aria-hidden="true"></div>
        <div class="eyebrow materialize" style="animation-delay:0.1s;">Bloemfontein &middot; Quality Used Vehicles</div>
        <h1 class="materialize" style="animation-delay:0.25s; font-size:clamp(30px,5.4vw,44px); margin:14px 0 10px; line-height:1.1;">Find your next car, book a test drive today.</h1>
        <p class="materialize" style="animation-delay:0.4s; font-size:16px; max-width:56ch; line-height:1.6; color:var(--ink-soft); margin:0;">Real stock, updated daily. Selling instead? <a href="/evaluate" style="color:var(--coral); font-weight:600;">Get a trade-in value &rarr;</a></p>
      </div>`;

  const filterBar = `
    <div class="card materialize hero-search" style="animation-delay:0.55s; position:relative; z-index:5; margin-top:${heroMedia ? "-64px" : "20px"}; margin-bottom:32px; padding:24px 26px;">
      <div class="search-form">
        <div class="search-field">
          <label for="f-make">Make</label>
          <select id="f-make" data-filter="make">
            <option value="all">All makes</option>
            ${uniqueMakes.map(m => `<option value="${m.toLowerCase()}">${m}</option>`).join("")}
          </select>
        </div>
        <div class="search-field">
          <label for="f-price">Price Range</label>
          <select id="f-price" data-filter="price">
            <option value="all">Any price</option>
            <option value="low">Under R150k</option>
            <option value="mid">R150k&ndash;R300k</option>
            <option value="high">R300k+</option>
          </select>
        </div>
        <div class="search-field">
          <label for="f-transmission">Gearbox</label>
          <select id="f-transmission" data-filter="transmission">
            <option value="all">Any gearbox</option>
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
          </select>
        </div>
        <button type="button" id="find-car-btn" class="btn btn-primary search-btn">Find Car</button>
      </div>
      <div id="stock-count" class="mono-count">${stock.length} of ${stock.length} vehicles</div>
    </div>
  `;

  const body = `
    ${hero}
    <div id="recently-viewed-section" style="display:none; margin-top:20px;">
      <h2 style="font-size:20px;">Recently Viewed</h2>
      <div id="recently-viewed-list"></div>
    </div>
    ${filterBar}
    <div class="reveal" style="margin-bottom:18px;">
      <h2 id="stock" style="font-size:26px; margin:0;">Current Stock</h2>
    </div>
    <div id="stock-grid">
      ${stockCards || '<div class="card">No stock currently listed.</div>'}
    </div>
    <div id="stock-empty" class="card" style="display:none; text-align:center;">No vehicles match those filters right now &mdash; try widening your search.</div>

    ${heroPhotos.length >= 3 ? `
    <div class="reveal" style="margin-top:48px;">
      <h2 style="font-size:24px; margin-bottom:6px;">From the Floor</h2>
      <p style="color:var(--ink-soft); font-size:14px; margin-top:0; max-width:56ch;">Real, random shots from what's on the lot right now &mdash; no stock photography.</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:16px;">
        ${heroSlides.map(src => `
          <div class="card tilt-card" style="padding:0; overflow:hidden;">
            <img src="${src}" alt="A vehicle on the AutoShow floor" loading="lazy" style="width:100%; aspect-ratio:1; object-fit:cover; display:block;">
          </div>
        `).join("")}
      </div>
    </div>
    ` : `
    <div class="reveal" style="margin-top:48px;">
      <h2 style="font-size:24px; margin-bottom:6px;">Real Customers, Real Handovers</h2>
      <p style="color:var(--ink-soft); font-size:14px; margin-top:0; max-width:56ch;">Every AutoShow sale ends with keys in hand, not just a receipt. Ask us for references from any of these buyers.</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:16px;">
        ${[1,2,3,4].map(() => `
          <div class="vehicle-image-placeholder" style="aspect-ratio:1;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>
            <span>Customer photo</span>
          </div>
        `).join("")}
      </div>
    </div>
    `}

    <div class="card reveal" style="text-align:center; margin-top:30px;">
      <p style="margin-top:0;">Know someone looking for a car?</p>
      <a href="https://wa.me/?text=${encodeURIComponent('Check out AutoShow Bloemfontein for quality used cars: ' + 'https://autoshow.sabelalogic.co.za')}" class="btn btn-whatsapp">Share on WhatsApp</a>
    </div>

    <script>
      // Free "recently viewed" render - reads what /vehicle/ pages saved to
      // this browser's own localStorage, no server tracking involved.
      try {
        const recent = JSON.parse(localStorage.getItem('autoshow_recently_viewed') || '[]');
        if (recent.length) {
          document.getElementById('recently-viewed-section').style.display = 'block';
          const list = document.getElementById('recently-viewed-list');
          list.innerHTML = recent.map(id =>
            '<a href="/vehicle/' + id + '" style="display:inline-block; margin-right:8px; font-family:JetBrains Mono,monospace; font-size:12px; color:var(--coral);">' + id + '</a>'
          ).join('');
        }
      } catch (e) {}
    </script>

    <script>
      // Silent hero video slideshow - crossfades between clips, pausing
      // whichever isn't visible so only one plays (and downloads) at a time.
      (function () {
        const slides = Array.from(document.querySelectorAll('.hero-video-slide'));
        if (!slides.length) return;

        if (prefersReducedMotion) {
          slides.forEach((v) => { v.pause(); v.removeAttribute('autoplay'); });
          return;
        }

        slides[0].play().catch(() => {});
        if (slides.length < 2) return;

        let i = 0;
        setInterval(() => {
          const current = slides[i];
          i = (i + 1) % slides.length;
          const next = slides[i];
          next.preload = 'auto';
          next.currentTime = 0;
          next.play().catch(() => {});
          next.classList.add('active');
          current.classList.remove('active');
          setTimeout(() => current.pause(), 1900);
        }, 14000);
      })();
    </script>

    <script>
      // Search form - everything needed is already on the page, so filtering
      // just toggles card visibility instead of a re-fetch.
      (function () {
        const state = { make: 'all', price: 'all', transmission: 'all' };
        const cards = Array.from(document.querySelectorAll('.stock-card'));
        const countEl = document.getElementById('stock-count');
        const emptyEl = document.getElementById('stock-empty');
        const grid = document.getElementById('stock-grid');

        function apply() {
          let visible = 0;
          cards.forEach((card) => {
            const matches =
              (state.make === 'all' || card.dataset.make === state.make) &&
              (state.price === 'all' || card.dataset.price === state.price) &&
              (state.transmission === 'all' || card.dataset.transmission === state.transmission);
            card.style.display = matches ? '' : 'none';
            if (matches) visible++;
          });
          if (countEl) countEl.textContent = visible + ' of ' + cards.length + ' vehicles';
          if (emptyEl) emptyEl.style.display = visible === 0 ? 'block' : 'none';
        }

        document.querySelectorAll('.search-field select').forEach((select) => {
          select.addEventListener('change', () => {
            state[select.dataset.filter] = select.value;
            apply();
          });
        });

        const findBtn = document.getElementById('find-car-btn');
        if (findBtn) {
          findBtn.addEventListener('click', () => {
            apply();
            if (grid) grid.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
          });
        }
      })();
    </script>
  `;
  return new Response(pageShell("Home", body, `
  /* Diagonal brand-colour wash behind the hero - soft and blurred rather
     than a flat shape, bleeding past the hero's own (now dissolving) edges. */
  .hero-wrap { position: relative; }
  .diagonal-accent {
    position: absolute; top: -48px; right: -70px; width: 52%; height: 135%;
    background: linear-gradient(135deg, rgba(227,30,43,0.6) 0%, rgba(43,99,235,0.42) 55%, transparent 100%);
    clip-path: polygon(28% 0, 100% 0, 100% 100%, 0% 100%);
    filter: blur(46px); z-index: 0; pointer-events: none;
    animation: materialize 1.4s cubic-bezier(0.16,1,0.3,1) both, drift 11s ease-in-out 1.4s infinite;
  }
  .hero-stage.has-photos {
    position: relative; z-index: 1;
    -webkit-mask-image: radial-gradient(ellipse 92% 90% at 50% 58%, #000 60%, transparent 100%);
    mask-image: radial-gradient(ellipse 92% 90% at 50% 58%, #000 60%, transparent 100%);
  }

  /* Silent background video slideshow - crossfades between clips at a
     deliberately lowered opacity so it reads as atmosphere, not footage. */
  .hero-video-stack { position: absolute; inset: 0; z-index: 0; }
  .hero-video-slide {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
    opacity: 0; transition: opacity 1.8s ease; z-index: 0;
  }
  .hero-video-slide.active { opacity: 0.55; z-index: 1; }

  @keyframes drift {
    0%, 100% { transform: translate(0,0) scale(1); opacity: 0.9; }
    50% { transform: translate(-12px, 14px) scale(1.05); opacity: 1; }
  }

  /* Ethereal materialize-in for above-the-fold hero content - a soft
     dissolve from blur/scale rather than a hard cut-in. */
  .materialize { opacity: 0; animation: materialize 1s cubic-bezier(0.16,1,0.3,1) both; }
  @keyframes materialize {
    0% { opacity: 0; filter: blur(14px); transform: translateY(14px) scale(0.98); }
    100% { opacity: 1; filter: blur(0); transform: translateY(0) scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .materialize, .diagonal-accent { animation: none !important; opacity: 1; filter: none; transform: none; }
  }

  /* Same dissolve language on scroll-reveal further down the page. */
  .reveal {
    filter: blur(8px);
    transition: opacity 0.9s cubic-bezier(0.16,1,0.3,1), transform 0.9s cubic-bezier(0.16,1,0.3,1), filter 0.9s cubic-bezier(0.16,1,0.3,1);
  }
  .reveal.in { filter: blur(0); }

  /* Dropdown search form, styled as one continuous glass "search bar" that
     overlaps the hero rather than the earlier pill-chip filter bar. */
  .hero-search { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end; }
  .search-form { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; flex: 1; }
  .search-field { display: flex; flex-direction: column; gap: 6px; min-width: 150px; }
  .search-field label {
    font-family: 'JetBrains Mono', monospace; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--ink-soft);
  }
  .search-field select {
    appearance: none; -webkit-appearance: none; width: 100%;
    font-family: 'Manrope', sans-serif; font-weight: 600; font-size: 14px; color: var(--ink);
    background: rgba(255,255,255,0.7) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%235C5D63' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 12px center;
    border: 1px solid var(--line); border-radius: 10px; padding: 11px 34px 11px 12px; cursor: pointer;
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }
  .search-field select:hover { border-color: var(--ink-soft); }
  .search-field select:focus { border-color: var(--sage); }
  .search-btn { white-space: nowrap; align-self: flex-end; }
  .mono-count {
    font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--ink-soft);
    white-space: nowrap; align-self: center; margin-left: auto;
  }
  @media (max-width: 640px) {
    .search-form { flex-direction: column; align-items: stretch; }
    .search-field { min-width: 0; }
    .search-btn { width: 100%; justify-content: center; }
    .mono-count { margin-left: 0; }
  }
  `, {
    ogDescription: "Real stock, updated daily. Book a test drive or trade in your car at AutoShow Bloemfontein.",
  }), { headers: { "Content-Type": "text/html" } });
}

async function renderVehiclePage(path, env, url) {
  const stockId = path.split("/vehicle/")[1];
  const item = await getStockItem(stockId, env);
  if (!item) return new Response("Vehicle not found", { status: 404 });

  const similar = await getSimilarVehicles(item, env);
  const vehicleTitle = `${item.year} ${item.make} ${item.model}`;
  const price = Number(item.retail_price);

  // Free structured data - JSON-LD schema markup for Google's vehicle rich results.
  // No paid SEO tool needed, this is plain schema.org markup Google reads directly.
  const schema = {
    "@context": "https://schema.org",
    "@type": "Car",
    "name": vehicleTitle,
    "brand": item.make,
    "model": item.model,
    "vehicleModelDate": String(item.year),
    "mileageFromOdometer": { "@type": "QuantitativeValue", "value": item.mileage, "unitCode": "KMT" },
    "fuelType": item.fuel_type,
    "vehicleTransmission": item.transmission,
    "offers": {
      "@type": "Offer",
      "price": price,
      "priceCurrency": "ZAR",
      "availability": item.status === "available" ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      "seller": { "@type": "AutoDealer", "name": "AutoShow Bloemfontein" }
    }
  };

  const similarCards = similar.map(s => `
    <a href="/vehicle/${s.stock_id}" style="text-decoration:none; color:inherit;">
      <div class="card">
        <div style="font-weight:700;">${s.year} ${s.make} ${s.model}</div>
        <div style="font-family:'Fraunces',serif; color:var(--sage); font-weight:600;">R ${Number(s.retail_price).toLocaleString()}</div>
      </div>
    </a>
  `).join("");

  const body = `
    <div class="card" style="margin-top:30px;">
      ${item.photo_urls ? `<img src="${item.photo_urls}" alt="${vehicleTitle}" style="width:100%; aspect-ratio:16/9; object-fit:cover; border-radius:12px; margin-bottom:18px;">` : ""}
      <div class="eyebrow">${item.condition}</div>
      <h1>${vehicleTitle}</h1>
      <div style="font-family:'Fraunces',serif; font-size:26px; color:var(--sage); font-weight:600; margin:10px 0;">R ${price.toLocaleString()}</div>
      <p style="color:var(--ink-soft);">${item.mileage ? item.mileage.toLocaleString() + ' km &middot; ' : ''}${item.transmission} &middot; ${item.fuel_type} &middot; ${item.location}</p>
      <div style="display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;">
        <a href="/test-drive?stock_id=${item.stock_id}" class="btn btn-primary" aria-label="Book a test drive for this ${vehicleTitle}">Book Test Drive</a>
        <a href="https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi, I'm interested in the ${vehicleTitle}`)}" class="btn btn-whatsapp" aria-label="Contact us on WhatsApp about this vehicle">WhatsApp Us</a>
      </div>
    </div>

    <div class="card">
      <h2 style="font-family:'Fraunces',serif; margin-top:0;">Estimated Monthly Payment</h2>
      <p style="color:var(--ink-soft); font-size:13px; margin-top:-6px;">Rough estimate only - not a finance offer. Confirm your actual rate with AutoShow.</p>
      <label for="deposit">Deposit (R)</label>
      <input type="number" id="deposit" value="${Math.round(price * 0.1)}">
      <label for="rate">Interest Rate (% per year)</label>
      <input type="number" id="rate" value="15" step="0.1">
      <label for="term">Term (months)</label>
      <select id="term">
        <option value="36">36</option>
        <option value="48">48</option>
        <option value="60" selected>60</option>
        <option value="72">72</option>
      </select>
      <div id="calc-result" style="font-family:'Fraunces',serif; font-size:22px; font-weight:600; color:var(--coral); margin-top:10px;"></div>
    </div>

    ${similar.length ? `
      <h2 style="font-family:'Fraunces',serif;">Similar Vehicles You Might Like</h2>
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px;">
        ${similarCards}
      </div>
    ` : ""}

    <script type="application/ld+json">${JSON.stringify(schema)}</script>
    <script>
      // Free "recently viewed" - stored in the visitor's own browser, no
      // server-side tracking, no PII, no paid personalization vendor.
      try {
        const RECENT_KEY = 'autoshow_recently_viewed';
        let recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        recent = recent.filter(id => id !== '${item.stock_id}');
        recent.unshift('${item.stock_id}');
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 5)));
      } catch (e) { /* localStorage unavailable - fail silently */ }

      // Free payment calculator - standard amortization formula, no credit
      // bureau API needed for a rough estimate.
      const price = ${price};
      function calc() {
        const deposit = parseFloat(document.getElementById('deposit').value) || 0;
        const annualRate = parseFloat(document.getElementById('rate').value) || 0;
        const months = parseInt(document.getElementById('term').value);
        const principal = Math.max(price - deposit, 0);
        const monthlyRate = annualRate / 100 / 12;
        const payment = monthlyRate === 0
          ? principal / months
          : (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
        document.getElementById('calc-result').textContent =
          'R ' + Math.round(payment).toLocaleString() + ' / month';
      }
      ['deposit','rate','term'].forEach(id =>
        document.getElementById(id).addEventListener('input', calc)
      );
      calc();
    </script>
  `;
  return new Response(pageShell(vehicleTitle, body, "", {
    ogTitle: vehicleTitle,
    ogDescription: `R ${price.toLocaleString()} - ${item.mileage ? item.mileage.toLocaleString() + 'km ' : ''}${item.transmission} ${item.fuel_type}`,
    ogUrl: url.toString(),
  }), { headers: { "Content-Type": "text/html" } });
}

async function renderBookingPage(type, url, env) {
  const stockId = url.searchParams.get("stock_id") || "";
  const isTestDrive = type === "test_drive";
  const title = isTestDrive ? "Book a Test Drive" : "Get a Trade-In Evaluation";
  const subtitle = isTestDrive
    ? "Pick a time and we'll have the car ready for you."
    : "Tell us about your car and we'll give you a cash or trade-in offer.";

  let vehicleContext = "";
  if (isTestDrive && stockId) {
    const item = await getStockItem(stockId, env);
    if (item) vehicleContext = `<div class="card" style="background:rgba(18,62,145,0.10);">Booking for: <strong>${item.year} ${item.make} ${item.model}</strong></div>`;
  }

  const body = `
    <div style="padding:30px 0 10px;">
      <div class="eyebrow">${isTestDrive ? "Test Drive" : "Sell / Trade-In"}</div>
      <h1>${title}</h1>
      <p style="color:var(--ink-soft);">${subtitle}</p>
    </div>
    ${vehicleContext}
    <div class="card">
      <form id="booking-form">
        <label>Your Name</label>
        <input type="text" name="customer_name" required>
        <label>WhatsApp Number</label>
        <input type="tel" name="customer_phone" placeholder="e.g. 0821234567" required>
        ${!isTestDrive ? `
        <label>Vehicle Make & Model (the one you're selling)</label>
        <input type="text" name="notes" placeholder="e.g. 2019 Toyota Corolla 1.6">
        ` : ""}
        <label>Preferred Date/Time</label>
        <input type="datetime-local" name="scheduled_time">
        <input type="hidden" name="stock_id" value="${stockId}">
        <input type="hidden" name="appointment_type" value="${type}">
        <button type="submit" class="btn btn-primary" style="width:100%;">Confirm Booking</button>
      </form>
      <div id="result" style="margin-top:14px; font-family:'JetBrains Mono',monospace; font-size:13px;"></div>
    </div>

    <script>
      document.getElementById('booking-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const data = Object.fromEntries(new FormData(form).entries());
        const resultEl = document.getElementById('result');
        resultEl.textContent = 'Booking...';
        try {
          const res = await fetch('/api/appointments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          const json = await res.json();
          if (json.success) {
            const waText = encodeURIComponent(
              'Hi, I just booked a ${isTestDrive ? "test drive" : "trade-in evaluation"} on the AutoShow site. My name is ' + data.customer_name
            );
            resultEl.innerHTML = 'Booked! Confirming on WhatsApp now...';
            window.location.href = 'https://wa.me/${WHATSAPP_NUMBER}?text=' + waText;
          } else {
            resultEl.textContent = 'Error: ' + (json.error || 'something went wrong');
          }
        } catch (err) {
          resultEl.textContent = 'Network error - please WhatsApp us directly instead.';
        }
      });
    </script>
  `;
  return new Response(pageShell(title, body), { headers: { "Content-Type": "text/html" } });
}

async function renderSitemap(env, url) {
  // Free SEO win - lets Google discover every vehicle page without waiting
  // for organic crawl links. No paid SEO tool required.
  const stock = await getStock(env);
  const base = `${url.protocol}//${url.host}`;
  const urls = [
    `<url><loc>${base}/</loc><changefreq>daily</changefreq></url>`,
    `<url><loc>${base}/evaluate</loc><changefreq>weekly</changefreq></url>`,
    ...stock.map(s => `<url><loc>${base}/vehicle/${s.stock_id}</loc><changefreq>daily</changefreq></url>`),
  ].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}

function renderRobots(url) {
  const base = `${url.protocol}//${url.host}`;
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`, {
    headers: { "Content-Type": "text/plain" },
  });
}

async function renderDashboard(env) {
  const stock = await getStock(env);
  const leads = await getLeads(env);
  const { results: appointments } = await env.DB.prepare(
    "SELECT * FROM appointments WHERE dealer_id = ? ORDER BY created_at DESC"
  ).bind(DEALER_ID).all();

  const body = `
    <h1 style="margin-top:30px;">Operations Dashboard</h1>
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:24px;">
      <div class="card" style="min-width:100px;"><div style="font-family:'Fraunces',serif; font-size:22px; font-weight:600;">${stock.length}</div><div style="font-family:'JetBrains Mono',monospace; font-size:9px; text-transform:uppercase; color:var(--ink-soft);">Stock</div></div>
      <div class="card" style="min-width:100px;"><div style="font-family:'Fraunces',serif; font-size:22px; font-weight:600;">${leads.length}</div><div style="font-family:'JetBrains Mono',monospace; font-size:9px; text-transform:uppercase; color:var(--ink-soft);">Leads</div></div>
      <div class="card" style="min-width:100px;"><div style="font-family:'Fraunces',serif; font-size:22px; font-weight:600;">${appointments.length}</div><div style="font-family:'JetBrains Mono',monospace; font-size:9px; text-transform:uppercase; color:var(--ink-soft);">Appointments</div></div>
    </div>
    <h2 style="font-family:'Fraunces',serif;">Appointments</h2>
    ${appointments.length ? appointments.map(a => `
      <div class="card">
        <strong>${a.customer_name}</strong> &middot; ${a.customer_phone}<br>
        <span style="color:var(--ink-soft); font-size:13px;">${a.appointment_type} &middot; ${a.scheduled_time || 'time TBC'} &middot; ${a.status}</span>
      </div>
    `).join("") : '<div class="card">No appointments booked yet - these appear here the moment someone books via /test-drive or /evaluate.</div>'}
    <h2 style="font-family:'Fraunces',serif;">Top Leads</h2>
    ${leads.slice(0, 10).map(l => `
      <div class="card">
        <strong>${l.contact_name}</strong> &middot; score ${l.usability_score} &middot; ${l.location}<br>
        <span style="color:var(--ink-soft); font-size:13px;">${l.target_vehicle || ''} ${l.contact_phone ? '&middot; ' + l.contact_phone : ''}</span>
      </div>
    `).join("")}
  `;
  return new Response(pageShell("Dashboard", body), { headers: { "Content-Type": "text/html" } });
}
