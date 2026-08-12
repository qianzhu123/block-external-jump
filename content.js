// content.js —— isolated world (default), document_start injection.
// Two jobs:
//   1) Bridge: listen for __bej_request__ CustomEvents from inject.js (MAIN world),
//          ask background via chrome.runtime.sendMessage, reply via __bej_reply__.
//   2) UI: on a POPUP request, inject a bottom-right Shadow DOM card showing the
//          target URL + three buttons, and return the user's choice to inject.js.
//
// Why UI in the isolated world: isolated scripts can't read/write page JS's window,
//   but can touch the DOM; and the page author's styles won't leak into our Shadow DOM.

( function () {
  const REQ = "__bej_request__";
  const REP = "__bej_reply__";

  function reply( id, result ) {
    window.dispatchEvent( new CustomEvent( REP, { detail: { id, result } } ) );
  }

  window.addEventListener( REQ, async ( e ) => {
    const { id, kind, payload } = e.detail || {};
    try {
      if ( kind === "ENABLED" ) {
        const r = await chrome.runtime.sendMessage( { type: "CHECK", pageUrl: payload.pageUrl } );
        reply( id, { enabled: !!( r && r.enabled ) } );
        return;
      }
      if ( kind === "EXCEPTION" ) {
        const r = await chrome.runtime.sendMessage( {
          type: "IS_EXCEPTION", fromDomain: payload.fromDomain, toDomain: payload.toDomain,
        } );
        reply( id, { exception: !!( r && r.exception ) } );
        return;
      }
      if ( kind === "POPUP" ) {
        const action = await showPopup( payload.toUrl, payload.fromDomain, payload.toDomain );
        if ( action === "never" ) {
          // permanent allow: write exceptions on its behalf
          try {
            await chrome.runtime.sendMessage( {
              type: "ADD_EXCEPTION",
              fromDomain: payload.fromDomain, toDomain: payload.toDomain,
            } );
          } catch {}
        }
        reply( id, { action } );
        return;
      }
      reply( id, {} );
    } catch ( err ) {
      console.warn( "[bej] bridge error:", err );
      reply( id, null );
    }
  } );

  // ---------------- Popup UI ----------------
  // Shadow DOM avoids page style pollution; container pinned bottom-right.
  const HOST_ID = "__bej_popup_host__";
  let hostEl = null;
  let shadowRoot = null;
  let attachedResolve = null;

  function ensureHost() {
    if ( hostEl && document.body && document.body.contains( hostEl ) ) return hostEl;
    hostEl = document.createElement( "div" );
    hostEl.id = HOST_ID;
    hostEl.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;"
      + "width:340px;font-family:system-ui,Segoe UI,Microsoft YaHei,sans-serif;";
    if ( document.body ) document.body.appendChild( hostEl );
    else {
      // body not ready yet (document_start): wait for DOMContentLoaded
      document.addEventListener( "DOMContentLoaded", () => document.body.appendChild( hostEl ), { once: true } );
    }
    if ( !shadowRoot ) {
      shadowRoot = hostEl.attachShadow( { mode: "open" } );
      shadowRoot.innerHTML = `
        <style>
          :host{all:initial}
          .card{
            background:#1f2430;color:#e6e8eb;border:1px solid #39404d;border-radius:12px;
            box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden;
            font-size:13px;line-height:1.5;opacity:0;transform:translateY(8px);
            transition:opacity .15s ease, transform .15s ease;
          }
          .card.show{opacity:1;transform:translateY(0)}
          .head{display:flex;align-items:center;gap:8px;padding:10px 12px 4px}
          .badge{width:18px;height:18px;flex:0 0 auto;border-radius:50%;
            background:#f04444;color:#fff;display:flex;align-items:center;
            justify-content:center;font-weight:700;font-size:12px}
          .title{font-weight:600;letter-spacing:.2px}
          .url{margin:4px 12px 10px;padding:8px 10px;background:#161a22;border-radius:8px;
            font-family:Consolas,Menlo,monospace;font-size:12px;color:#9bd0ff;
            word-break:break-all;max-height:120px;overflow:auto}
          .btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:#39404d}
          .btn{background:#262c38;color:#e6e8eb;border:0;padding:10px 6px;cursor:pointer;
            font-size:13px;font-family:inherit;transition:background .12s}
          .btn:hover{background:#313846}
          .btn.primary{background:#2f6fed;color:#fff}
          .btn.primary:hover{background:#3f7df0}
          .btn.danger{background:#3a1f24;color:#ffb4b4}
          .btn.danger:hover{background:#4a262d}
          .sub{padding:8px 12px;background:#1a1e28;color:#8a91a0;font-size:11px;text-align:center}
        </style>
        <div class="card" id="card">
          <div class="head">
            <div class="badge">!</div>
            <div class="title">External redirect blocked</div>
          </div>
          <div class="url" id="url"></div>
          <div class="btns">
            <button class="btn primary" id="bVisit">Visit</button>
            <button class="btn" id="bNever">Don't notify again</button>
            <button class="btn danger" id="bConfirm">Confirm</button>
          </div>
          <div class="sub">Visit = allow once · Don't notify again = always allow this pair · Confirm = stay on this page</div>
        </div>`;
    }
    return hostEl;
  }

  function showPopup( toUrl, fromDomain, toDomain ) {
    return new Promise( ( resolve ) => {
      const tryRender = () => {
        if ( !document.body ) {
          setTimeout( tryRender, 30 );
          return;
        }
        const host = ensureHost();
        const sr = shadowRoot;
        const card = sr.getElementById( "card" );
        sr.getElementById( "url" ).textContent = toUrl;
        const visit = sr.getElementById( "bVisit" );
        const never = sr.getElementById( "bNever" );
        const confirm = sr.getElementById( "bConfirm" );

        // Drop old listeners (when popping multiple times)
        const fresh = ( el, html ) => { el.outerHTML = html; return sr.getElementById( el.id ); };
        const v = fresh( visit, '<button class="btn primary" id="bVisit">Visit</button>' );
        const n = fresh( never, '<button class="btn" id="bNever">Don\'t notify again</button>' );
        const c = fresh( confirm, '<button class="btn danger" id="bConfirm">Confirm</button>' );

        let done = false;
        const finish = ( action ) => {
          if ( done ) return;
          done = true;
          card.classList.remove( "show" );
          setTimeout( () => { if ( host.parentNode ) host.parentNode.removeChild( host ); hostEl = null; }, 200 );
          rootResolve( action );
        };
        v.addEventListener( "click", () => finish( "visit" ) );
        n.addEventListener( "click", () => finish( "never" ) );
        c.addEventListener( "click", () => finish( "confirm" ) );

        // enter animation
        requestAnimationFrame( () => card.classList.add( "show" ) );
      };

      let rootResolve = resolve;
      tryRender();
    } );
  }
} )();
