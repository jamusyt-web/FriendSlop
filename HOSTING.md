# Put FriendSlop online (Render)

When you're done you'll have a link like **https://friendslop.onrender.com**. Anyone who opens it can play, and
the desktop/Steam version of the game connects to that same server.

Everything below is clicking in a web browser. No terminal needed.

**Cost:** the **Starter** plan is about **$7 a month** (Render shows the exact price before you confirm). It is
always on. There is also a **Free** plan, but it falls asleep after about 15 minutes with no players, and the next
person waits about a minute for it to wake up. Free is fine for testing; use Starter once real players (or Steam)
depend on it.

---

## Before you start

The project files `render.yaml` and `Dockerfile` must be on GitHub:

1. Open https://github.com/jamusyt-web/FriendSlop
2. Look at the list of files. You should see `render.yaml` and `Dockerfile`.
   - Don't see them? Click the branch button above the file list (it says `main`) and pick
     `claude/youthful-heisenberg-8049v7`. If you see them there, remember to pick that branch in step 2 below.

## Step 1: Make a Render account

1. Open https://render.com
2. Click **Get Started** (top right).
3. Click **GitHub**.
4. If GitHub asks, log in, then click **Authorize Render**.
5. Finish the short sign-up form. If Render emails you, click the link in that email.

## Step 2: Create the server from the Blueprint

1. In the Render dashboard, click **+ New** (top right), then **Blueprint**.
2. You'll see a list of your GitHub repositories.
   - If **FriendSlop** isn't in the list: click **Configure GitHub** (or **Connect GitHub account**), choose
     **jamusyt-web**, choose **Only select repositories**, pick **FriendSlop**, click **Save** / **Install**, then
     go back to the Render tab.
3. Click **Connect** next to **jamusyt-web/FriendSlop**.
4. Fill in the form:
   - **Blueprint Name:** `FriendSlop`
   - **Branch:** `main`. Or, if the files were only on the other branch (see "Before you start"), pick
     `claude/youthful-heisenberg-8049v7`.
5. Render reads `render.yaml` and shows one service: **friendslop** (web service, Starter).
6. Click **Apply** (the button may say **Deploy Blueprint**).
7. If Render asks for a payment card, add it. The Starter plan needs one.
8. Check the branch: open https://dashboard.render.com, click **friendslop**, click **Settings**, and find
   **Branch**. It must be the branch you picked in step 4. If it isn't: click **Edit** next to it, pick the right
   branch, click **Save**, then click **Manual Deploy** → **Deploy latest commit** (top right).

## Step 3: Wait for the first deploy (5–10 minutes)

1. Open https://dashboard.render.com and click **friendslop**.
2. Click **Logs** in the left menu. You'll see the game being built.
3. It's ready when the logs show this line and the page header says **Live** in green:

   ```
   FriendSlop production server: http://localhost:10000  (ws: /ws)
   ```

   (The `localhost:10000` part is normal. That's what the server sees from the inside.)

If it says **Deploy failed**: click **Events** in the left menu, click the failed deploy, copy the last 30 lines of
the log, and paste them to Claude.

## Step 4: Find your link and test it

1. On the **friendslop** page, look under the name at the top. There's a link like
   `https://friendslop.onrender.com`. It may have extra letters, like `https://friendslop-ab12.onrender.com`, if
   someone else already took the name. **Write this link down.** You'll need it for the Steam version too.
2. Click the link. The FriendSlop menu should appear.
3. Type a name, click **Create Room**. You get a 4-letter room code.
4. On a second computer, open the same link, type the code, click **Join**. (A phone can join too, but only to
   watch: the game needs a keyboard and mouse.)
5. If you can see each other running around, it works.

## Step 5: Share it

Send your friends the link. One person clicks **Create Room** and shares the 4-letter code; everyone else types the
code and clicks **Join**. It works in Chrome, Edge, and Firefox on PC or Mac.

---

## How updates work (auto-deploy)

- Every time new code lands on the branch you picked, Render rebuilds the game and switches over by itself. That takes
  about 3–5 minutes, and you don't need to click anything.
- **Rooms are kept in memory, so they are wiped when the server switches.** Anyone playing at that moment gets
  disconnected. Tell them to refresh the page and make a new room. It's best to update when nobody is playing.
- To redeploy by hand, open **friendslop**, click **Manual Deploy**, then **Deploy latest commit**.
- If you picked the `claude/...` branch and later merge everything into `main`: open **friendslop**, click
  **Settings**, find **Branch**, change it to `main`, and save.

## Change plan or region

Both live in the `render.yaml` file. Change them there (not only in Render's settings), otherwise Render may switch
them back the next time the file syncs. To edit the file on the GitHub website:

1. Open https://github.com/jamusyt-web/FriendSlop and pick the branch Render uses (branch button above the files).
2. Click **render.yaml**, then the **pencil** icon (top right of the file, "Edit this file").
3. Change the word after `plan:` or `region:` (keep the space after the colon). Leave everything else as it is.
4. Click **Commit changes…**, then **Commit changes** again. Render picks it up by itself within a few minutes.

- **Plan:** `starter` (always on) or `free` (sleeps when nobody plays).
- **Region:** `oregon` (US West) by default. If most players are in Europe, use `frankfurt`. Other choices are
  `ohio`, `virginia`, and `singapore`. Do this **before step 2**: the region can't be changed after the server
  exists. Changing it later means deleting the service and doing step 2 again, which also gives you a new link.

## Troubleshooting

- **The page loads but you can't create or join a room:** check that **friendslop** says **Live**, then refresh the
  page.
- **The first visit takes about a minute:** you're on the Free plan and the server was asleep. Switch to Starter
  (see "Change plan or region").
- **Players get kicked every so often:** that happens when an update deploys (see above).

---

## Other hosts (optional, short version)

The same `Dockerfile` runs anywhere that runs Docker containers. The server listens on the port in the `PORT`
setting (3000 if none is set).

- **Fly.io:** install `flyctl`, run `fly launch --ha=false` in the FriendSlop folder (it finds the Dockerfile; the
  internal port is 3000), then `fly deploy`. Keep exactly **one** machine: rooms live in the server's memory, so
  players on two machines can't see each other's rooms. To keep it always on, set `min_machines_running = 1` in
  `fly.toml`.
- **Railway:** New Project → Deploy from GitHub repo → FriendSlop. It finds the Dockerfile by itself.
- **Any Linux server with Docker:** `docker build -t friendslop .` then
  `docker run -d --restart unless-stopped -p 80:3000 friendslop`
