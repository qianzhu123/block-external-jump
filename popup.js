// popup.js —— toolbar one-click add/remove of the current site
( function () {
  const siteEl = document.getElementById( "site" );
  const statusEl = document.getElementById( "status" );
  const toggle = document.getElementById( "toggle" );
  const optsLink = document.getElementById( "opts" );

  function regDomain( urlStr ) {
    try {
      const u = new URL( urlStr );
      const host = u.hostname;
      const parts = host.split( "." );
      if ( parts.length <= 2 ) return host;
      const allNum = parts.every( p => /^[0-9]{1,3}$/.test(p) );
      if ( allNum ) return host;
      if ( /^\d+$/.test(parts[0]) ) return host;
      const secondLast = parts[parts.length - 2];
      if ( secondLast.length <= 2 ) return parts.slice( -3 ).join( "." );
      return parts.slice( -2 ).join( "." );
    } catch {
      return "";
    }
  }

  let currentDomain = "";
  let currentUrl = "";
  let isBlacklisted = false;

  async function refresh() {
    const [tab] = await chrome.tabs.query( { active: true, currentWindow: true } );
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
      siteEl.textContent = "(unsupported page)";
      statusEl.textContent = "Only http/https pages can be managed.";
      toggle.disabled = true;
      toggle.textContent = "Unavailable";
      return;
    }
    currentUrl = tab.url;
    currentDomain = regDomain( currentUrl );
    siteEl.textContent = currentDomain || currentUrl;
    const data = await chrome.runtime.sendMessage( { type: "GET_ALL" } );
    const list = ( data && data.blacklist ) || [];
    isBlacklisted = list.includes( currentDomain );
    renderStatus();
  }

  function renderStatus() {
    if ( isBlacklisted ) {
      statusEl.className = "status on";
      statusEl.textContent = "Already in the blacklist → cross-origin redirects will be intercepted.";
      toggle.textContent = "Remove from blacklist";
      toggle.className = "btn remove";
    } else {
      statusEl.className = "status";
      statusEl.textContent = "Not in the blacklist → no interception.";
      toggle.textContent = "Add to blacklist";
      toggle.className = "btn";
    }
  }

  toggle.addEventListener( "click", async () => {
    if ( !currentDomain ) return;
    if ( isBlacklisted ) {
      await chrome.runtime.sendMessage( { type: "DEL_RULE", rule: currentDomain } );
    } else {
      await chrome.runtime.sendMessage( { type: "ADD_RULE", rule: currentDomain } );
    }
    isBlacklisted = !isBlacklisted;
    renderStatus();
  } );

  optsLink.addEventListener( "click", ( e ) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  } );

  refresh();
} )();
