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
      if ( !( await isEnabled() ) ) return "allow";
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
        gateJump( url ).then( ( v ) => {
          if ( v === "allow" ) savedAssign( url );
        } );
      },
    } );
  }
  window.location.assign = function ( url ) {
    gateJump( url ).then( ( v ) => { if ( v === "allow" ) savedAssign( url ); } );
  };
  window.location.replace = function ( url ) {
    gateJump( url ).then( ( v ) => { if ( v === "allow" ) savedReplace( url ); } );
  };
  window.open = function ( url, ...rest ) {
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
