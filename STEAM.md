# FriendSlop on Steam: beginner checklist

Do these in order. Tick each box as you go.

**What it costs and how long it takes**

- **$100** per game (the "Steam Direct fee"). Valve pays it back once the game has earned $1,000.
- Account checks take a few days. Store page review takes 3–5 business days, and so does build review. The
  "Coming Soon" page must be public for **at least 2 weeks** before release. First-time developers also wait about
  **30 days** after paying the fee (Steamworks shows your exact earliest release date). Plan on 1–2 months total.
- The game needs the online server from [HOSTING.md](HOSTING.md), so do that first and keep it on the **Starter**
  plan. The Steam version connects to that server.

**What you'll need:** a Windows PC, **Node.js LTS** from https://nodejs.org (install with all the default options),
and the FriendSlop folder on that PC. To get the folder: install **GitHub Desktop** (https://desktop.github.com),
click **File → Clone repository**, pick **jamusyt-web/FriendSlop**, click **Clone**. If the `electron` and `steam`
folders are missing, click **Current branch** at the top and pick `claude/youthful-heisenberg-8049v7` (or whichever
branch your Render server uses, see HOSTING.md).

---

## 1. Join Steamworks (one time)

- [ ] Turn on the **Steam Guard Mobile Authenticator** in the Steam phone app. Steamworks and uploads need it.
- [ ] Open https://partner.steamgames.com and click **Join Steamworks** (or **Sign up**). Log in with your Steam account.
- [ ] Enter your legal name (yours, or your company's), address, and email.
- [ ] Sign the **Steam Distribution Agreement** (it's done online).
- [ ] Pay the **$100 Steam Direct fee**. This gives you one "app credit".
- [ ] **Tax interview:** answer the questions with your real legal info. A US person gets the W-9 form; everyone else
      gets W-8BEN. The site picks the right one for you.
- [ ] **Bank info:** this is where Valve sends your money.
- [ ] **Identity verification:** follow the steps on screen (photo ID).
- [ ] Wait for the "approved" email.

## 2. Create the app

- [ ] On the Steamworks home page, click **Create new app** (it uses your app credit). Name it `FriendSlop`.
- [ ] Write down your **App ID** (a number like `1234560`). You'll need it below.
- [ ] Your Windows **Depot ID** is usually the App ID + 1 (like `1234561`). You'll check it in step 3.

To reach the settings pages below: **Steamworks → Apps & Packages → All Applications → FriendSlop →
Edit Steamworks Settings**. After changing any of them, open the **Publish** tab, click **Prepare for Publishing**,
then **Publish to Steam**, and type the confirmation text it asks for.

## 3. Depots (where the game files go)

- [ ] **Edit Steamworks Settings → SteamPipe → Depots**.
- [ ] One depot already exists (ID = App ID + 1). Set its **Operating System** to **Windows**. Write down its ID.
- [ ] *(Optional, Linux / Steam Deck native)* Click **Add New Depot**, name it `FriendSlop Linux`, write down its ID,
      and set **Operating System** to **Linux + SteamOS**. Read the "Linux and Steam Deck" section at the end first.
- [ ] **Save**, then Publish (see the end of step 2).

## 4. Install folder and launch options

- [ ] **Edit Steamworks Settings → Installation → General Installation**.
- [ ] **Install Folder:** `FriendSlop`
- [ ] **Launch Options → Add new launch option**:
  - **Executable:** `FriendSlop.exe`
  - **Launch Type:** Launch (Default)
  - **Operating System:** Windows
  - Click **Update**.
- [ ] *(Only if you made the Linux depot)* Add a second launch option:
  - **Executable:** `friendslop`
  - **Arguments:** `--no-sandbox` (Steam's Linux container blocks the browser engine's sandbox, and without this the
    game may not open)
  - **Operating System:** Linux + SteamOS
- [ ] Publish (see the end of step 2).

## 5. Build the Windows game on your PC

1. Get the newest code: in **GitHub Desktop**, click **Fetch origin**, then **Pull origin** if it shows up.
2. Open the **FriendSlop** folder in File Explorer (GitHub Desktop: **Repository → Show in Explorer**).
3. Click the address bar at the top (where the folder path is), type `powershell`, and press **Enter**. A terminal
   opens in that folder.
4. Copy-paste this line and press **Enter**. It takes a few minutes. Type `npm.cmd` exactly like this, not `npm`
   (plain `npm` stops with "running scripts is disabled on this system" on most Windows PCs).

   ```
   npm.cmd install
   ```

   Yellow `npm warn deprecated ...` lines and a line about "vulnerabilities" are normal (they're in the build
   tools, not in the game). Don't run `npm audit fix`.

5. Tell the build where your server is. Use **your** link from HOSTING.md step 4, between the quotes:

   ```
   $env:SERVER_URL = "https://friendslop.onrender.com"
   ```

6. Build it:

   ```
   npm.cmd run dist:win
   ```

   Near the top it prints `Desktop build will connect to: wss://...onrender.com/ws`. Check that it's your link.
   If you see **WARNING: SERVER_URL is not set**, do step 5 again in this same window.

7. When it finishes, open the folder `release\win-unpacked` and double-click **FriendSlop.exe**. The game opens.
   Click **Create Room**, then open your website link in a browser, type the code, and **Join**. If you see each
   other, the desktop build talks to your server correctly. (F11 switches fullscreen on and off.)

**If the game opens but can't create a room:** the `SERVER_URL` link is wrong, or the server isn't **Live** on Render.
Fix the link (step 5), then run step 6 again. `$env:SERVER_URL` only lasts until you close that PowerShell window,
so every new build starts at step 5.

## 6. Upload the build with steamcmd

- [ ] Download steamcmd: https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip
- [ ] Make a folder `C:\steamcmd`, right-click the zip → **Extract All…** → choose `C:\steamcmd` → **Extract**.
- [ ] In the FriendSlop folder, open `steam\app_build.vdf` with **Notepad**. Replace `<<APPID>>` with your App ID and
      `<<WINDOWS_DEPOTID>>` with your Windows depot ID. Keep the quotes, so it looks like `"AppID" "1234560"`. Save.
- [ ] Open `steam\depot_build_windows.vdf` with Notepad and replace `<<WINDOWS_DEPOTID>>` the same way. Save.
      (GitHub Desktop now lists these two files as changed. That's expected; leave them like that.)
- [ ] Get the full path of `app_build.vdf`: in File Explorer, hold **Shift**, right-click `app_build.vdf`, and choose
      **Copy as path**.
- [ ] Copy the line below into Notepad first. Replace `YOUR_STEAM_LOGIN` with your Steam **account name** (the name
      you log in with, not your profile name). Then select the example path **including its quotes** and paste yours
      over it (Ctrl+V; the pasted path brings its own quotes). Copy the finished line into PowerShell and press
      **Enter**:

  ```
  C:\steamcmd\steamcmd.exe +login YOUR_STEAM_LOGIN +run_app_build "C:\Users\YOU\Documents\GitHub\FriendSlop\steam\app_build.vdf" +quit
  ```

- [ ] The first time, steamcmd updates itself (about a minute). Then it asks for your **password** (nothing shows
      while you type, which is normal). Then either type the **Steam Guard code** from the Steam app on your phone,
      or tap **Approve** on the sign-in request the Steam app shows.
- [ ] Success looks like `Successfully finished AppID 1234560 build (BuildID 12345678)`.

You do this again (all of step 5, then step 6) every time you update the game. steamcmd remembers your login,
so later uploads usually skip the password.

## 7. Put the build on a beta branch and try it

- [ ] **Edit Steamworks Settings → SteamPipe → Builds**.
- [ ] Click **Create new branch** (or **Manage Branches → New**), name it `beta`, give it a password if you like,
      and save.
- [ ] Find your newest build in the list. In its **Set build live on branch…** menu, choose **beta**, click
      **Preview Change**, then **Set Build Live Now**.
- [ ] In the Steam app on your PC, go to your **Library**. FriendSlop should be there, because your developer
      account owns it. Right-click it → **Properties → Betas** → choose **beta** (enter the password if you set one).
      Then click **Install**, then **Play**.
- [ ] When it's good, do the same thing but choose the **default** branch. That's the version everyone gets, and it's
      the one Valve reviews.

## 8. Let friends playtest (Steam keys)

- [ ] On the FriendSlop page in Steamworks, click **Request Steam Product Keys**.
- [ ] Pick the package whose name ends in **Beta Testing** (these keys work before release). Ask for, say, 20 keys.
      Add a note like "friends playtest".
- [ ] Once they're approved, click **Download keys**. You get a file with one key per line.
- [ ] Give each friend one key. They open Steam → **Games** menu (or **+ Add a Game** at the bottom left) →
      **Activate a Product on Steam…** → paste the key. FriendSlop shows up in their library. If you only set the
      build live on **beta**, they also pick **beta** under Properties → Betas.

## 9. Store page

Open **Steamworks → FriendSlop → Edit Store Page**. Fill in every tab. The checklist on that page shows what's still
missing.

**Text**

- [ ] **Short description** (300 characters max). For example: *"Hot-potato tag with up to 16 friends. Hold the bomb
      when it blows and you lose. Tag someone to pass it, grab chaotic items from ? boxes, and survive random chaos
      events like low gravity, ice floors and lights out."*
- [ ] **About This Game:** a longer version. Say it's **online multiplayer (2–16 players), internet required**,
      and that you play with friends using a 4-letter room code.
- [ ] **Languages:** English (Interface).
- [ ] **System requirements (Windows):** Windows 10/11 64-bit, 4 GB RAM, a graphics card from the last 8 years,
      broadband internet.
- [ ] **Content survey:** answer honestly. It's cartoon bombs and slapstick, with no blood.
- [ ] **Features:** Online PvP, Multi-player.
- [ ] **Tags** (up to 20, most important first): Multiplayer, Online PvP, Party Game, Party, Casual, Funny, Comedy,
      Cute, Colorful, Cartoony, 3D, Third Person, 3D Platformer, Physics, Action, Fast-Paced, Arcade, PvP,
      Family Friendly, Indie.

**Images** (PNG or JPG, exact sizes; every capsule must show the game's name or logo)

| Image | Size (pixels) |
|---|---|
| Header capsule | 920 × 430 |
| Small capsule | 462 × 174 |
| Main capsule | 1232 × 706 |
| Vertical capsule | 748 × 896 |
| Page background (optional) | 1438 × 810 |
| Screenshots: **at least 5**, real gameplay | 1920 × 1080 |
| Library capsule | 600 × 900 |
| Library header | 920 × 430 |
| Library hero (art only, no text) | 3840 × 1240 |
| Library logo (transparent PNG) | 1280 wide and/or 720 tall |

Don't put review quotes, award badges, or "sale" text on capsules.

- [ ] **Trailer** (strongly recommended): MP4, 1920 × 1080, 30–90 seconds. Show gameplay in the first 5 seconds.

**Getting screenshots and clips:** run the desktop game on a 1920 × 1080 screen and press **F11** for fullscreen.
Press **Win + PrtScn** for a screenshot (saved in `Pictures\Screenshots`). Press **Win + Alt + R** to start and stop
recording a clip (Xbox Game Bar, saved in `Videos\Captures`). Once the game is installed through Steam, **F12** takes
Steam screenshots, and Steam's own **Game Recording** (Steam → Settings → Game Recording) saves clips too.

## 10. Coming Soon page

- [ ] In the store page checklist, click **Mark as ready for review**. Valve checks it in 3–5 business days. Send it
      at least a week before you want it public.
- [ ] Once it's approved, click **Publish** to make the **Coming Soon** page public. Do this **at least 2 weeks**
      before release. Earlier is better, because it collects wishlists.
- [ ] Set the release date (or leave it as "Coming soon").

## 11. Release checklist

- [ ] Steamworks account approved (tax, bank, and ID all done).
- [ ] Waiting period after the fee is over (Steamworks shows the earliest date).
- [ ] Store page approved, and Coming Soon public for 2+ weeks.
- [ ] Build uploaded and live on the **default** branch. Depots and launch options are published.
- [ ] Game build checklist → **Mark as ready for review**, and it passed (3–5 business days).
- [ ] Price set (**Pricing** section), or marked Free to Play.
- [ ] Server on Render is **Live** on the **Starter** plan.
- [ ] Tested on a second PC that never had the game: installed from Steam and played with someone on the website.
- [ ] On release day: Steamworks → FriendSlop → **Release** → press the release button.

**Updating after release:** rebuild (all of step 5), upload (step 6), and set the new build live on **default**
(step 7).
Server code updates go out through Render on their own. When the game's network messages change, update the server
**and** the Steam build together, because old desktop builds may stop working with a newer server.

---

## Linux and Steam Deck

- Steam Deck can run the **Windows** version through Proton (Steam's compatibility layer). After step 7, test it on a
  Deck: Library → FriendSlop → ⚙ → **Properties → Compatibility** → tick **Force the use of a specific Steam Play
  compatibility tool** → pick the newest Proton.
- A **native Linux** depot is optional. Upload it **from a Linux computer**, because uploading from Windows can drop
  the "allowed to run" permission on the game files. On Linux:
  1. `npm install`
  2. `SERVER_URL=https://friendslop.onrender.com npm run dist:win` (use your own link)
  3. `SERVER_URL=https://friendslop.onrender.com npm run dist:linux`
  4. In `steam/app_build.vdf`, remove the `//` in front of the `<<LINUX_DEPOTID>>` line. Fill in both depot IDs, and
     the one in `steam/depot_build_linux.vdf` too.
  5. `steamcmd +login YOUR_STEAM_LOGIN +run_app_build "$PWD/steam/app_build.vdf" +quit`

  This uploads both Windows and Linux in one go. Remember the Linux launch option from step 4.

## What's in the steam folder

| File | What it is |
|---|---|
| `steam/app_build.vdf` | The main upload script. Your App ID and depot IDs go here. |
| `steam/depot_build_windows.vdf` | Uploads `release/win-unpacked/` (FriendSlop.exe and its files). |
| `steam/depot_build_linux.vdf` | Uploads `release/linux-unpacked/` (optional). |
| `steam/output/` | Created by steamcmd (logs). Safe to delete; git ignores it. |

## Later, not now

Steam achievements, the Steam overlay (Shift+Tab), and "Join game" friend invites can be added later with the
`steamworks.js` package for Electron. The game doesn't need any of them to launch on Steam.
