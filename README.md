# External Jump Blocker

On blacklisted sites, block page-triggered **cross-origin redirects** and show a
**non-native custom card** in the bottom-right corner that displays the target
URL, with three buttons:

- **Visit** — allow this redirect only (this single time)
- **Don't notify again** — permanently allow this pair of `current-site → target-site` (stored in a list, removable from the options page)
- **Confirm** — keep the block, stay on the page, close the popup

One codebase, **works in both Chrome and Edge** (both Chromium / Manifest V3, same `chrome.*` API).

## Install (self-hosted, load unpacked in developer mode)

### Edge
1. Open `edge://extensions/`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** → select the `block-external-jump/` folder

### Chrome
1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** → select the `block-external-jump/` folder

After install, a red "no-entry + arrow" icon appears in the toolbar.

## Usage

### 1) Add a site to the blacklist (fastest way)
- Open any page on the site you want to block
- Click the toolbar icon → popup shows the current domain
- Click **Add to blacklist** → done. That domain (and all its subdomains) is now blocked
- Click the icon again → the button turns red and says **Remove from blacklist**, click to remove

### 2) Full management (blacklist add/remove + permanent-allow list)
- From the popup, click the **Options page** link, or on the extensions page open the plugin's **Details → Extension options**
- **Blacklist rules**: enter a rule string + Add, remove one-by-one, or clear all
- **Permanent allow list**: each "Don't notify again" choice accumulates here; revoke one-by-one or clear all

### 3) When a redirect is intercepted
- A card floats in the bottom-right showing the target URL
- Click any of the three buttons as needed

## Matching rules

- **Blacklist = substring match**: if the string you enter appears anywhere in a page's URL, interception is enabled on that page.
  Entering a full domain (e.g. `example.com`) also covers `www.example.com`, `m.example.com` and all subdomains, since each subdomain URL contains `example.com`.
  ⚠️ Too-short strings will over-match (e.g. `apple` matches both `apple.com` and `pineapple.io`) — fill down to the domain level.
- **Cross-origin = registrable domain (eTLD+1) differs**: if the current page and the target share the same registrable domain, it's treated as an in-site redirect and **always allowed, never blocked**.
- **Permanent allow**: recorded per pair `{source-domain → allowed-target-domain}`. Same pair redirects again silently, no popup.

## Jump entry points covered

`window.open` / `location.href` (setter) / `location.assign` / `location.replace`
/ `<a>` clicks (incl. `target=_blank`, capture phase) / cross-origin `<form>` submit /
blocks pages from registering the deceptive `beforeunload` listener / cross-origin
`<meta http-equiv=refresh>`.

## Known limitations (acceptable for self-use)

- **Async allow on sync APIs**: `window.open` / `location.assign` etc. are synchronous and cannot `await` a user decision mid-call.
  This extension first stops the original synchronous behavior (`preventDefault` or `return null`), then runs `gateJump` async and uses the underlying native method to actually perform the redirect when allowed.
  Most sites are unaffected; a few sites that **strongly depend on the `window` handle returned by `window.open`** will get `null`.
- **`window.location` is not replaceable as a whole**: it's a read-only `Location` instance; only `href`'s setter and `assign`/`replace` can be overridden.
  A few sites may bypass via a cloned `Location` reference or `eval`-generated redirect scripts. Patch as encountered.
- **Some obfuscated sites** may build redirects via `eval` outside the standard entry points and may slip through. Known boundary.
- **Timeout falls back to allow**: if the blocking layer gets no response from the isolated world within 1.5 s (extreme case), it allows by default to avoid freezing the page.

## Directory layout

```
block-external-jump/
├── manifest.json     # MV3 manifest, one codebase for Chrome/Edge
├── background.js     # service worker: storage + message handling
├── inject.js         # MAIN world, document_start: hijack redirect APIs
├── content.js        # isolated world: bridge + Shadow DOM popup UI
├── popup.html / .js  # toolbar one-click add/remove current site
├── options.html / .js# full management: blacklist + permanent allow list
└── icons/            # icon16 / 48 / 128.png
```

## Debugging

- After changes, click **Reload** on the extension's card on the extensions page
- Popup logic logs to the page Console (`console.warn("[bej] ...")` from content/inject)
- Storage data: extensions page → your plugin → the **Service worker** link to open the background inspect, then in the Console run
  `chrome.storage.local.get(null, console.log)`

## License

MIT.
