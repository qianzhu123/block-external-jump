// inject.js —— MAIN world, document_start injection.
// Hijacks APIs that can trigger cross-origin redirects; on hit, talks to
// content.js (isolated world) via CustomEvent, which renders the popup.
//
// CustomEvent protocol:
//   REQ = "__bej_request__"  detail { id, kind, payload }
//   REP = "__bej_reply__"    detail { id, result }
//   kinds: ENABLED / EXCEPTION / POPUP
//   POPUP returns result.action = "visit" | "never" | "confirm"
//
// Synchronous APIs (window.open / location.assign, etc.) cannot await mid-call:
//   first stop the original synchronous behavior (e.preventDefault or return null),
//   then run gateJump async; if allowed, use the underlying native method to actually navigate.
//
// Key: when allowing, never use a hijacked API (e.g. location.href=), or gateJump
//   fires again in a loop. Always go through savedAssign / savedOpen / rawOpenUrl.
//   After a "Visit" allow, the URL enters passToken; if a second gate still fires,
//   the token makes it allow silently without a popup.
( function () {
  const REQ = "__bej_request__";
  const REP = "__bej_reply__";
  let seq = 0;
  const pending = new Map();

  window.addEventListener( REP, ( e ) => {
    const d = e.detail || {};
    const r = pending.get( d.id );
    if ( !r ) return;
    pending.delete( d.id );
    r.resolve( d.result );
  } );

  function ask( kind, payload, timeoutMs ) {
    const id = ++seq;
    return new Promise( ( resolve ) => {
      pending.set( id, { resolve } );
      window.dispatchEvent( new CustomEvent( REQ, { detail: { id, kind, payload } } ) );
      setTimeout( () => {
        if ( pending.has( id ) ) {
          pending.delete( id );
          console.warn( "[bej] ask timeout, allow:", kind );
          resolve( null );
        }
      }, timeoutMs || 1500 );
    } );
  }

  async function isEnabled() {
    const r = await ask( "ENABLED", { pageUrl: location.href } );
    return !!( r && r.enabled === true );
  }
  async function isException( fromDomain, toDomain ) {
    const r = await ask( "EXCEPTION", { fromDomain, toDomain } );
    return !!( r && r.exception === true );
  }
  async function askPopup( toUrl, fromDomain, toDomain ) {
    const r = await ask( "POPUP", { toUrl, fromDomain, toDomain }, 60000 );
    return ( r && r.action ) || "confirm";
  }

  // Page-mode cache: hit/miss for "current page URL is in blacklist" with a TTL.
  // Avoids the chicken-and-egg: hijack is installed synchronously at document_start,
  // but the background check needs at least one round-trip. If we install the hijack
  // unconditionally, we have to swallow the very first navigation if the bridge isn't
  // ready yet — which is exactly the bug the user hit. Cache says: if we don't know
  // yet, just allow (no interception). Once the first reply lands we know the truth
  // and behave correctly from then on. First visit to a blacklisted page may slip
  // through once; the user can refresh to re-evaluate.
  let enabledCache = null;          // null = unknown, true = in blacklist, false = not
  let enabledCacheAt = 0;
  const CACHE_TTL_MS = 30 * 1000;

  function noteEnabled( v, url ) {
    enabledCache = !!v;
    enabledCacheAt = Date.now();
    enabledCacheUrl = url || location.href;
  }
  let enabledCacheUrl = "";

  async function isEnabledCached() {
    const now = Date.now();
    if (
      enabledCache !== null &&
      enabledCacheUrl === location.href &&
      ( now - enabledCacheAt ) < CACHE_TTL_MS
    ) return enabledCache;
    const r = await ask( "ENABLED", { pageUrl: location.href } );
    const v = !!( r && r.enabled === true );
    noteEnabled( v, location.href );
    return v;
  }

  // Listen for blacklist changes pushed by background so cache stays in sync across tabs.
  window.addEventListener( "__bej_blacklist_changed__", ( e ) => {
    const d = e.detail || {};
    if ( d && typeof d.pageUrl === "string" && d.pageUrl === location.href ) {
      noteEnabled( !!d.enabled, location.href );
    }
  } );

  // Wait for the content-script bridge to install before priming. Without this,
  // a fast page may dispatch REQ before content.js has attached its listener,
  // the ask() will time out after 1500 ms, and we leave enabledCache=null —
  // which keeps the hijack on its "fast-path: allow native" branch, which is
  // exactly what we want. The bridge_ready handshake makes the priming
  // predictable in the common case (we get an answer within milliseconds).
  function whenBridgeReady( timeoutMs ) {
    return new Promise( ( resolve ) => {
      let done = false;
      const finish = () => { if ( done ) return; done = true; resolve( true ); };
      window.addEventListener( "__bej_bridge_ready__", finish, { once: true } );
      setTimeout( () => { if ( !done ) { done = true; resolve( false ); } }, timeoutMs || 200 );
    } );
  }

  ( async () => {
    await whenBridgeReady();
    try { await isEnabledCached(); } catch {}
  } )();

  // Periodic re-check while the page is alive: if a blacklisted page was opened
  // before its rule was added, the first nav will be allowed; re-check on a timer
  // so subsequent navs are intercepted.
  setInterval( () => {
    if ( document.visibilityState !== "visible" ) return;
    isEnabledCached().catch( () => {} );
  }, 5 * 1000 );

  function regDomain( urlStr ) {
    try {
      const u = new URL( urlStr );
      const host = u.hostname;
      const parts = host.split( "." );
      if ( parts.length <= 2 ) return host;           // single/two labels: e.g. localhost, 127.0.0.1
      const allNum = parts.every( p => /^[0-9]{1,3}$/.test(p) );
      if ( allNum ) return host;                        // IPv4: keep whole host
      const isV4ish = /^\d+$/.test( parts[0] );        // safety: if first label is pure digits, keep whole host
      if ( isV4ish ) return host;
      const secondLast = parts[parts.length - 2];
      if ( secondLast.length <= 2 ) return parts.slice( -3 ).join( "." );
      return parts.slice( -2 ).join( "." );
    } catch {
      return "";
    }
  }
  function isExternal( toUrl ) {
    try {
      const to = new URL( toUrl, location.href );
      return regDomain( to.href ) !== regDomain( location.href );
    } catch {
      return false;
    }
  }

  // Pass token: after a "Visit" allow, the same URL is allowed on later gates (prevents a second-gate deadlock)
  const passToken = new Set();
  function normUrl( s ) {
    try { return new URL( s, location.href ).href; } catch { return s; }
  }

  async function gateJump( toUrl ) {
    try {
      if ( !isExternal( toUrl ) ) return "allow";
      if ( passToken.has( normUrl( toUrl ) ) ) return "allow";
      // Same-site nav never needs the popup; even when enabled, allow silently.
      // (isExternal already returned true here, so this is a fast-path for "current
      // page not in blacklist → allow" so we never fire the popup for non-blacklisted
      // sites.)
      if ( !( await isEnabledCached() ) ) return "allow";
      const fromDomain = regDomain( location.href );
      const toDomain = regDomain( toUrl );
      if ( await isException( fromDomain, toDomain ) ) return "allow";
      const action = await askPopup( toUrl, fromDomain, toDomain );
      if ( action === "visit" ) {
        passToken.add( normUrl( toUrl ) );
        return "allow";
      }
      if ( action === "never" ) return "allow";
      return "block";
    } catch ( e ) {
      console.warn( "[bej] gateJump error, allow:", e );
      return "allow";
    }
  }

  const savedOpen = window.open;
  const savedAssign = window.location.assign.bind( window.location );
  const savedReplace = window.location.replace.bind( window.location );
  const LocProto = Object.getPrototypeOf( window.location );
  const hrefDesc = Object.getOwnPropertyDescriptor( LocProto, "href" );

  function rawOpenUrl( url ) {
    try { savedAssign( url ); }
    catch ( e ) {
      if ( hrefDesc && hrefDesc.set ) hrefDesc.set.call( window.location, url );
    }
  }

  if ( hrefDesc && hrefDesc.set ) {
    Object.defineProperty( LocProto, "href", {
      configurable: true,
      enumerable: true,
      get() { return hrefDesc.get.call( this ); },
      set( url ) {
        // Fast-path: if we don't yet know whether this page is blacklisted (very
        // first gate on a freshly-loaded page), fall back to the native setter
        // synchronously. The background check will land within a few ms; from
        // then on, gates will block. Without this, the very first
        // `location.href = ...` after document_start can fire while the
        // content-script bridge hasn't installed its CustomEvent listener yet,
        // the request times out, and the navigation silently dies.
        if ( enabledCache === null ) {
          hrefDesc.set.call( window.location, url );
          return;
        }
        if ( !enabledCache ) {
          hrefDesc.set.call( window.location, url );
          return;
        }
        gateJump( url ).then( ( v ) => {
          if ( v === "allow" ) savedAssign( url );
        } );
      },
    } );
  }
  window.location.assign = function ( url ) {
    if ( enabledCache === null || !enabledCache ) {
      return savedAssign( url );
    }
    gateJump( url ).then( ( v ) => { if ( v === "allow" ) savedAssign( url ); } );
  };
  window.location.replace = function ( url ) {
    if ( enabledCache === null || !enabledCache ) {
      return savedReplace( url );
    }
    gateJump( url ).then( ( v ) => { if ( v === "allow" ) savedReplace( url ); } );
  };
  window.open = function ( url, ...rest ) {
    if ( enabledCache === null || !enabledCache ) {
      return savedOpen.call( window, url, ...rest );
    }
    gateJump( url ).then( ( v ) => {
      if ( v === "allow" ) {
        try { savedOpen.call( window, url, ...rest ); } catch ( e ) {}
      }
    } );
    return null;
  };

  // <a> interception: capture-phase preventDefault; if async allowed, navigate via savedAssign / savedOpen.
  document.addEventListener( "click", function ( e ) {
    let el = e.target;
    while ( el && el.tagName !== "A" ) el = el.parentElement;
    if ( !el || !el.href ) return;
    const href = el.href;
    if ( !isExternal( href ) ) return;
    // Fast-path: not blacklisted → don't even preventDefault. Native click wins.
    if ( enabledCache === null || !enabledCache ) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const newTab = el.target && el.target !== "" && el.target !== "_self";
    gateJump( href ).then( ( v ) => {
      if ( v !== "allow" ) return;
      try {
        if ( newTab ) savedOpen.call( window, href );
        else savedAssign( href );
      } catch ( err ) {
        rawOpenUrl( href );
      }
    } );
  }, true );

  document.addEventListener( "submit", function ( e ) {
    const form = e.target;
    if ( !form || !form.action ) return;
    const action = form.action;
    if ( !isExternal( action ) ) return;
    if ( enabledCache === null || !enabledCache ) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    gateJump( action ).then( ( v ) => {
      if ( v === "allow" ) HTMLFormElement.prototype.submit.call( form );
    } );
  }, true );

  const savedAddEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function ( type, listener, opts ) {
    if ( type === "beforeunload" ) return;
    return savedAddEL.call( this, type, listener, opts );
  };

  function stripMetaRefresh() {
    if ( enabledCache === null || !enabledCache ) return;
    document.querySelectorAll( 'meta[http-equiv="refresh" i]' ).forEach( ( m ) => {
      const c = m.getAttribute( "content" ) || "";
      const low = c.toLowerCase();
      const idx = low.indexOf( "url=" );
      if ( idx < 0 ) return;
      let target = c.slice( idx + 4 ).trim().replace( /^['"]|['"]$/g, "" );
      try {
        const abs = new URL( target, location.href ).href;
        if ( isExternal( abs ) ) {
          if ( m.parentNode ) m.parentNode.removeChild( m );
          gateJump( abs ).then( ( v ) => { if ( v === "allow" ) rawOpenUrl( abs ); } );
        }
      } catch {}
    } );
  }
  const mo = new MutationObserver( () => stripMetaRefresh() );
  function bootObserver() {
    if ( document.documentElement ) {
      mo.observe( document.documentElement, { childList: true, subtree: true } );
      stripMetaRefresh();
    } else {
      setTimeout( bootObserver, 9 );
    }
  }
  bootObserver();
  if ( document.readyState === "loading" ) {
    document.addEventListener( "DOMContentLoaded", stripMetaRefresh );
  }
} )();
