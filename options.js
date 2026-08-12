// options.js —— full management: blacklist add/remove + permanent allow list cleanup
( function () {
  const blackTable = document.querySelector( "#blackTable tbody" );
  const excTable = document.querySelector( "#excTable tbody" );
  const newRule = document.getElementById( "newRule" );
  let data = { blacklist: [], exceptions: [] };

  async function load() {
    data = ( await chrome.runtime.sendMessage( { type: "GET_ALL" } ) ) || { blacklist: [], exceptions: [] };
    renderBlack();
    renderExc();
  }

  function renderBlack() {
    blackTable.innerHTML = "";
    const list = data.blacklist || [];
    if ( !list.length ) {
      blackTable.innerHTML = '<tr><td colspan="3" class="empty">(no rules)</td></tr>';
      return;
    }
    list.forEach( ( r, i ) => {
      const tr = document.createElement( "tr" );
      tr.innerHTML = `<td class="mono"></td><td class="created"></td><td class="action"></td>`;
      tr.children[0].textContent = r;
      // We don't store timestamps; use a placeholder
      tr.children[1].textContent = "—";
      const btn = document.createElement( "button" );
      btn.className = "danger";
      btn.textContent = "Remove";
      btn.addEventListener( "click", async () => {
        await chrome.runtime.sendMessage( { type: "DEL_RULE", rule: r } );
        load();
      } );
      tr.children[2].appendChild( btn );
      blackTable.appendChild( tr );
    } );
  }

  function renderExc() {
    excTable.innerHTML = "";
    const exc = data.exceptions || [];
    if ( !exc.length ) {
      excTable.innerHTML = '<tr><td colspan="3" class="empty">(no permanent allow)</td></tr>';
      return;
    }
    exc.forEach( ( it ) => {
      const tr = document.createElement( "tr" );
      tr.innerHTML = `<td class="mono"></td><td class="mono"></td><td class="action"></td>`;
      tr.children[0].textContent = it.from;
      tr.children[1].textContent = it.to;
      const btn = document.createElement( "button" );
      btn.className = "danger";
      btn.textContent = "Revoke";
      btn.addEventListener( "click", async () => {
        await chrome.runtime.sendMessage( { type: "DEL_EXCEPTION", fromDomain: it.from, toDomain: it.to } );
        load();
      } );
      tr.children[2].appendChild( btn );
      excTable.appendChild( tr );
    } );
  }

  document.getElementById( "addRule" ).addEventListener( "click", async () => {
    const v = ( newRule.value || "" ).trim();
    if ( !v ) return;
    const r = await chrome.runtime.sendMessage( { type: "ADD_RULE", rule: v } );
    data = { ...data, blacklist: r.blacklist };
    newRule.value = "";
    renderBlack();
  } );

  newRule.addEventListener( "keydown", ( e ) => {
    if ( e.key === "Enter" ) document.getElementById( "addRule" ).click();
  } );

  document.getElementById( "exportClean" ).addEventListener( "click", async () => {
    if ( !confirm( "Clear all blacklist rules?" ) ) return;
    await chrome.runtime.sendMessage( { type: "SET_BLACKLIST", blacklist: [] } );
    load();
  } );

  document.getElementById( "excClean" ).addEventListener( "click", async () => {
    if ( !confirm( "Clear all permanent allow entries?" ) ) return;
    await chrome.runtime.sendMessage( { type: "CLEAR_EXCEPTIONS" } );
    load();
  } );

  load();
} )();
