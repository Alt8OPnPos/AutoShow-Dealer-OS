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

// R2 key of a video to autoplay muted/looped behind the hero. Leave ""
// to fall back to the photo slideshow only.
const HERO_VIDEO_KEY = "YTShort_27Aug2026_13_41_13.mp4";

const BRAND = {
  paper: "#FBF8F3",
  ink: "#2B2620",
  inkSoft: "#6B6357",
  coral: "#E2896F",
  gold: "#EFC366",
  sage: "#7FA084",
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
  // Re-angles the gradient sweep on every request so the wordmark never
  // renders as a flat, identical bitmap twice - a lightweight generative
  // treatment that needs no external image tool.
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
    --line: rgba(43,38,32,0.10);
    --glass: rgba(255,255,255,0.6); --glass-border: rgba(255,255,255,0.7);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: 'Manrope', sans-serif; color: var(--ink);
    background:
      radial-gradient(circle at 15% 8%, rgba(239,195,102,0.14), transparent 45%),
      radial-gradient(circle at 90% 20%, rgba(226,137,111,0.12), transparent 40%),
      var(--paper);
    min-height: 100vh; padding-bottom: 60px;
  }
  header {
    max-width: 1100px; margin: 0 auto; padding: 20px; display: flex;
    justify-content: space-between; align-items: center;
    position: sticky; top: 0; z-index: 20;
    background: rgba(251,248,243,0.85); backdrop-filter: blur(14px);
    border-bottom: 1px solid transparent; transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  header.scrolled { border-bottom-color: var(--line); box-shadow: 0 4px 20px rgba(43,38,32,0.05); }
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
  .btn-primary { background: var(--sage); color: white; box-shadow: 0 4px 14px rgba(127,160,132,0.3); }
  .btn-primary:hover { box-shadow: 0 6px 18px rgba(127,160,132,0.4); }
  .btn-whatsapp { background: #22c55e; color: white; box-shadow: 0 4px 14px rgba(34,197,94,0.28); }
  .btn-whatsapp:hover { box-shadow: 0 6px 18px rgba(34,197,94,0.38); }
  .btn-outline { background: var(--glass); color: var(--ink); border: 1px solid var(--line); }
  .btn-outline:hover { border-color: var(--ink-soft); background: rgba(255,255,255,0.85); }
  .card {
    background: var(--glass); border: 1px solid var(--glass-border); backdrop-filter: blur(10px);
    border-radius: 18px; padding: 22px; margin-bottom: 14px;
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
  }
  .card:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(43,38,32,0.07); border-color: rgba(255,255,255,0.9); }
  .vehicle-image-placeholder {
    aspect-ratio: 16/9; border-radius: 12px; margin-bottom: 16px;
    background:
      repeating-linear-gradient(135deg, rgba(43,38,32,0.03) 0px, rgba(43,38,32,0.03) 2px, transparent 2px, transparent 14px),
      linear-gradient(135deg, rgba(226,137,111,0.10), rgba(239,195,102,0.10));
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

  /* Generated brand mark - an ink wordmark with a coral gleam that sweeps
     across it, re-angled per page load. Coral stays the only accent, same
     as the static dot always was - this is motion, not a new palette. */
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
    background: linear-gradient(180deg, rgba(43,38,32,0.10) 0%, rgba(43,38,32,0.5) 72%, rgba(43,38,32,0.78) 100%);
  }
  .hero-content { position: relative; z-index: 2; padding: 44px clamp(20px,4vw,48px); color: var(--paper); width: 100%; }
  .hero-content .eyebrow { color: var(--gold); }
  .hero-content h1 { color: var(--paper); }
  .hero-content p { color: rgba(251,248,243,0.88); }
  .hero-content .stat-strip span { color: rgba(251,248,243,0.78); }
  @media (prefers-reduced-motion: reduce) {
    .hero-slide { animation: none; transition: opacity 0.4s ease; }
    .hero-bg { transition: none !important; transform: none !important; }
  }
  ${extraHead}
</style>
<noscript><style>.reveal { opacity: 1 !important; transform: none !important; }</style></noscript>
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

  // Real floor-stock photos, shuffled - fuel both the hero slideshow and
  // the gallery strip below with actual random views of the lot.
  const heroPhotos = [...new Set(stock.map(s => s.photo_urls).filter(Boolean))];
  for (let i = heroPhotos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [heroPhotos[i], heroPhotos[j]] = [heroPhotos[j], heroPhotos[i]];
  }
  const heroSlides = heroPhotos.slice(0, 8);

  const stockCards = stock.map(s => `
    <div class="card tilt-card reveal">
      ${vehicleMedia(s)}
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">
        <div>
          <div style="font-weight:700; font-size:17px;"><a href="/vehicle/${s.stock_id}" style="color:inherit; text-decoration:none;">${s.year} ${s.make} ${s.model}</a></div>
          <div style="font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--ink-soft); margin-top:4px;">
            ${mileageText(s)}${s.transmission} &middot; ${s.fuel_type}
          </div>
        </div>
        <span style="font-family:'JetBrains Mono',monospace; font-size:10px; font-weight:700; padding:3px 9px; border-radius:20px; text-transform:uppercase; background:${s.status === 'available' ? 'rgba(127,160,132,0.22)' : 'rgba(239,195,102,0.28)'}; color:${s.status === 'available' ? '#3F5C43' : '#7A5B12'};">${s.status}</span>
      </div>
      <div style="font-family:'Fraunces',serif; font-weight:600; font-size:22px; color:var(--sage); margin:10px 0;">R ${Number(s.retail_price).toLocaleString()}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a href="/test-drive?stock_id=${s.stock_id}" class="btn btn-primary">Book Test Drive</a>
        <a href="https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(`Hi, I'm interested in the ${s.year} ${s.make} ${s.model} - is it still available?`)}" class="btn btn-whatsapp">WhatsApp Us</a>
      </div>
    </div>
  `).join("");

  const heroInner = `
      <div class="eyebrow">Bloemfontein &middot; Quality Used Vehicles</div>
      <h1 style="font-size:clamp(34px,7vw,54px); margin:0 0 16px; line-height:1.06;">Find your next car,<br>book a test drive today.</h1>
      <p style="font-size:17px; max-width:52ch; line-height:1.6;">Real stock, updated daily. No forms, no waiting for a call back &mdash; pick a car and book a time that works for you.</p>
      <div style="display:flex; gap:12px; margin-top:26px; flex-wrap:wrap;">
        <a href="#stock" class="btn btn-primary">View Stock</a>
        <a href="/evaluate" class="btn btn-outline">Sell or Trade In Your Car</a>
      </div>
      <div class="stat-strip" style="display:flex; gap:20px; margin-top:36px; flex-wrap:wrap; font-family:'JetBrains Mono',monospace; font-size:11px; text-transform:uppercase; letter-spacing:0.04em;">
        <span><i class="pulse-dot">&#9679;</i> ${stock.filter(s => s.status === 'available').length} vehicles available</span>
        <span><i class="pulse-dot">&#9679;</i> Updated daily</span>
        <span><i class="pulse-dot">&#9679;</i> No hidden fees</span>
      </div>
  `;

  const heroVideoUrl = HERO_VIDEO_KEY ? `/photos/${encodeURIComponent(HERO_VIDEO_KEY)}` : "";
  const heroMedia = heroVideoUrl
    ? `<video class="hero-video" id="hero-video" autoplay muted loop playsinline preload="auto"${heroSlides[0] ? ` poster="${heroSlides[0]}"` : ""}>
         <source src="${heroVideoUrl}" type="video/mp4">
       </video>`
    : heroSlides.length
      ? `<div class="hero-bg">
           ${heroSlides.map((src, i) => `<div class="hero-slide${i === 0 ? ' active' : ''}" style="background-image:url('${src}'); animation-delay:${(i * 0.6).toFixed(1)}s;"></div>`).join("")}
         </div>`
      : "";

  const hero = heroMedia
    ? `<div class="hero-stage has-photos" id="hero-stage">
        ${heroMedia}
        <div class="hero-overlay"></div>
        <div class="hero-content">${heroInner}</div>
      </div>`
    : `<div style="padding:56px 0 32px; position:relative;">${heroInner}</div>`;

  const body = `
    ${hero}
    <div id="recently-viewed-section" style="display:none; margin-top:20px;">
      <h2 style="font-size:20px;">Recently Viewed</h2>
      <div id="recently-viewed-list"></div>
    </div>
    <div class="reveal" style="display:flex; align-items:baseline; justify-content:space-between; margin-top:40px; margin-bottom:18px;">
      <h2 id="stock" style="font-size:26px; margin:0;">Current Stock</h2>
      <span style="font-family:'JetBrains Mono',monospace; font-size:11px; color:var(--ink-soft);">${stock.length} vehicles</span>
    </div>
    ${stockCards || '<div class="card">No stock currently listed.</div>'}

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
  `;
  return new Response(pageShell("Home", body, "", {
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
    if (item) vehicleContext = `<div class="card" style="background:rgba(127,160,132,0.12);">Booking for: <strong>${item.year} ${item.make} ${item.model}</strong></div>`;
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
