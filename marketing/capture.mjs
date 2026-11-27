// Captures Sift in a real VS Code: builds the extension, makes the demo repository, starts VS Code
// with a clean profile and Sift installed, plays the demo and saves screenshots and a video to out/.
//
//   npm run capture            screenshots and video
//   npm run capture -- --keep  leave VS Code open at the end
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { createDemo } from './demo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const work = path.join(here, '.work');
const out = path.join(here, 'out');
const keep = process.argv.includes('--keep');
const VSCODE = process.env.VSCODE_APP ?? '/Applications/Visual Studio Code.app';
// Window size in points, drawn at 2x so screenshots stay sharp on high-density screens.
const SIZE = { width: 1280, height: 720 };
const SCALE = 2;

function step(message) {
  console.log(`· ${message}`);
}

// ---- setup ----

step('Building Sift');
mkdirSync(out, { recursive: true });
const vsix = path.join(work, 'sift.vsix');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
execFileSync('npm', ['run', 'package', '--', '--out', vsix], { cwd: repo, stdio: 'ignore' });

step('Installing it in a clean profile');
const userDir = path.join(work, 'user');
const extDir = path.join(work, 'extensions');
const cli = path.join(VSCODE, 'Contents/Resources/app/bin/code');
execFileSync(cli, ['--user-data-dir', userDir, '--extensions-dir', extDir, '--install-extension', vsix, '--force'], { stdio: 'ignore' });

step('Making the demo repository');
const demo = createDemo(path.join(work, 'orbit-api'));

// Sift runs this as Claude Code: canned answers, same every time.
const claude = path.join(work, 'claude');
writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });

mkdirSync(path.join(userDir, 'User'), { recursive: true });
writeFileSync(
  path.join(userDir, 'User', 'settings.json'),
  JSON.stringify(
    {
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.enableExperiments': false,
      'workbench.layoutControl.enabled': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'chat.disableAIFeatures': true,
      'chat.commandCenter.enabled': false,
      'window.commandCenter': true,
      'window.restoreWindows': 'none',
      'window.zoomLevel': 0,
      'workbench.activity.showAccounts': false,
      'typescript.validate.enable': false,
      'javascript.validate.enable': false,
      'editor.lightbulb.enabled': 'off',
      'editor.renderWhitespace': 'none',
      'breadcrumbs.enabled': false,
      'git.decorations.enabled': false,
      'scm.diffDecorations': 'none',
      'editor.fontSize': 14,
      'editor.minimap.enabled': false,
      'editor.stickyScroll.enabled': false,
      'diffEditor.renderSideBySide': true,
      'diffEditor.hideUnchangedRegions.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'extensions.ignoreRecommendations': true,
      'security.workspace.trust.enabled': false,
      'git.openRepositoryInParentFolders': 'never',
      'sift.ai.provider': 'claude',
      'sift.ai.command': claude,
      'sift.agentSkills': [],
    },
    null,
    2,
  ),
);

// ---- VS Code ----

step('Starting VS Code');
const app = await electron.launch({
  executablePath: path.join(VSCODE, 'Contents/MacOS/Code'),
  args: [
    demo,
    `--user-data-dir=${userDir}`,
    `--extensions-dir=${extDir}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
    '--new-window',
    `--force-device-scale-factor=${SCALE}`,
  ],
  env: { ...process.env, SIFT_DEMO_DELAY_MS: process.env.SIFT_DEMO_DELAY_MS ?? '2500' },
});
// VS Code may open other windows first: wait for the workbench.
let page = null;
for (let i = 0; i < 120 && !page; i++) {
  page = app.windows().find((w) => w.url().includes('workbench.html')) ?? null;
  if (!page) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (!page) {
  throw new Error(`No VS Code window: ${app.windows().map((w) => w.url()).join(', ')}`);
}
const window = await app.browserWindow(page);
await window.evaluate((w, size) => {
  w.setBounds({ x: 40, y: 40, ...size });
  w.focus();
}, SIZE);
await page.waitForSelector('.part.activitybar', { state: 'attached', timeout: 60_000 });
await page.waitForTimeout(3000);

// The video: Chromium's screencast of the window, a frame each time it changes.
const frames = [];
/** Stretches of the recording to leave out of the video ([start, end] in seconds): the script's own moves. */
const cuts = [];
const cdp = await page.context().newCDPSession(page);
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  frames.push({ data, time: metadata.timestamp });
  void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
});
await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

/** Writes the frames as an MP4 and a GIF, each frame held until the next one. */
function saveVideo() {
  if (frames.length < 2) {
    return;
  }
  const dir = path.join(work, 'frames');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Leave out the cuts: frames inside one go, except the last, which shows from the end of the cut.
  // Merge overlapping cuts (one inside another) so no stretch is removed twice.
  const merged = [];
  for (const [start, end] of [...cuts].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  cuts.splice(0, cuts.length, ...merged);
  const kept = [];
  for (const frame of frames) {
    const cut = cuts.find(([start, end]) => frame.time > start && frame.time <= end);
    if (!cut) {
      kept.push({ ...frame });
      continue;
    }
    const last = kept.at(-1);
    if (last?.cutEnd === cut[1]) {
      kept[kept.length - 1] = { ...frame, time: cut[1], cutEnd: cut[1] };
    } else {
      kept.push({ ...frame, time: cut[1], cutEnd: cut[1] });
    }
  }
  const removed = (time) => cuts.filter(([, end]) => end <= time).reduce((sum, [start, end]) => sum + (end - start), 0);
  const edited = kept.map((frame) => ({ ...frame, time: frame.time - removed(frame.time) }));
  const list = [];
  edited.forEach((frame, i) => {
    const file = path.join(dir, `${String(i).padStart(5, '0')}.png`);
    writeFileSync(file, Buffer.from(frame.data, 'base64'));
    const next = edited[i + 1]?.time ?? frame.time + 2;
    list.push(`file '${file}'`, `duration ${Math.max(next - frame.time, 0.01).toFixed(3)}`);
  });
  list.push(`file '${path.join(dir, `${String(edited.length - 1).padStart(5, '0')}.png`)}'`);
  const concat = path.join(dir, 'frames.txt');
  writeFileSync(concat, list.join('\n') + '\n');
  const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  const input = ['-f', 'concat', '-safe', '0', '-i', concat];
  const { width, height } = { width: SIZE.width * SCALE, height: SIZE.height * SCALE };
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  const mp4 = path.join(out, 'demo.mp4');
  ffmpeg(...input, '-vf', `fps=30,${fit}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', mp4);
  ffmpeg('-i', mp4, '-vf', 'fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a', path.join(out, 'demo.gif'));
  step('Saved out/demo.mp4 and out/demo.gif');
}

const pause = (ms = 800) => page.waitForTimeout(ms);
let shot = 0;
/** Saves a screenshot without the video's caption. */
async function screenshot(name) {
  shot++;
  const file = path.join(out, `${String(shot).padStart(2, '0')}-${name}.png`);
  await offCamera(async () => {
    await page.evaluate(() => document.getElementById('sift-demo-caption')?.style.setProperty('visibility', 'hidden'));
    await page.screenshot({ path: file });
    // Wait for a frame with the caption back, so the video doesn't hold the frame without it.
    const before = frames.length;
    await page.evaluate(() => document.getElementById('sift-demo-caption')?.style.removeProperty('visibility'));
    for (let i = 0; i < 40 && frames.length === before; i++) {
      await page.waitForTimeout(50);
    }
  });
  step(`Saved ${path.relative(here, file)}`);
}

/** Lets the viewer take in what's on screen. */
const hold = (ms = 3000) => page.waitForTimeout(ms);

/** Shows a step's caption over the window, for the video only (screenshots leave it out). */
async function caption(number, text) {
  await page.evaluate(
    ([number, text]) => {
      let box = document.getElementById('sift-demo-caption');
      if (!box) {
        box = document.createElement('div');
        box.id = 'sift-demo-caption';
        Object.assign(box.style, {
          position: 'fixed', left: '50%', bottom: '44px', transform: 'translateX(-50%)', zIndex: '100000',
          display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 22px 12px 12px', borderRadius: '999px',
          background: '#f5f4f0', color: '#1e1c1a', boxShadow: '0 12px 32px rgba(0,0,0,.45), 0 0 0 1px rgba(0,0,0,.2)',
          font: '600 19px/1.2 -apple-system, "Helvetica Neue", Arial, sans-serif', letterSpacing: '-0.01em',
          whiteSpace: 'nowrap', pointerEvents: 'none', transition: 'opacity .25s ease',
        });
        const badge = document.createElement('span');
        Object.assign(badge.style, {
          display: 'grid', placeItems: 'center', width: '30px', height: '30px', borderRadius: '50%',
          background: '#c2410c', color: '#fff', font: '700 15px/1 -apple-system, Arial, sans-serif',
        });
        const label = document.createElement('span');
        box.append(badge, label);
        document.body.append(box);
      }
      box.firstChild.textContent = String(number);
      box.firstChild.style.display = number ? 'grid' : 'none';
      box.lastChild.textContent = text;
    },
    [number, text],
  );
}

/** Runs the script's own moves (scrolling, tidying up) and leaves them out of the video. */
async function offCamera(action) {
  const start = Date.now() / 1000;
  await action();
  await page.waitForTimeout(250);
  cuts.push([start, Date.now() / 1000]);
}

/** Runs a command by its title from the command palette. */
async function command(title) {
  await page.keyboard.press('F1');
  await page.waitForSelector('.quick-input-widget:not([style*="display: none"]) input');
  await page.keyboard.type(title, { delay: 15 });
  await pause(500);
  await page.keyboard.press('Enter');
  await pause();
}

/** A row of the Sift view by its text. */
function row(text) {
  return page.locator('.part.sidebar .monaco-list-row', { hasText: text }).first();
}

/** 1-based line of the first line containing `text` in a file of the demo. */
function lineOf(file, text) {
  return readFileSync(path.join(demo, file), 'utf8').split('\n').findIndex((l) => l.includes(text)) + 1;
}

/** Puts the cursor on a line of the right side of the diff editor, scrolled to the middle. */
async function goToLine(line) {
  await offCamera(async () => {
    await command('View: Focus Active Editor Group');
    await page.keyboard.press('Control+G');
    await page.keyboard.type(String(line));
    await page.keyboard.press('Enter');
    await pause(300);
  });
}

async function hidePanel() {
  const hide = page.locator('.part.panel .action-label[aria-label^="Hide Panel"], .part.panel .action-label[aria-label^="Close Panel"]');
  if (await hide.first().isVisible().catch(() => false)) {
    await offCamera(() => hide.first().click());
  }
}

async function clearNotifications() {
  await offCamera(() => command('Notifications: Clear All Notifications'));
}

async function expandAll() {
  await offCamera(() => command('Sift: Expand all'));
}

/** Clicks a button in the Sift view's title bar. */
async function titleButton(label) {
  await page.locator(`.part.sidebar .action-label[aria-label^="${label}"]`).first().click();
  // Move away so the button's tooltip doesn't show in the screenshots.
  await page.mouse.move(1000, 360);
  await pause();
}

/** Makes the side bar wider so commit messages fit. */
async function widenSideBar(by) {
  await offCamera(() => dragSash(by));
}

async function dragSash(by) {
  const box = await page.locator('.part.sidebar').boundingBox();
  const x = box.x + box.width + 1;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by, y, { steps: 8 });
  await page.mouse.up();
  await pause(300);
}

try {
  // 1. The clutter: everything the AI changed, in Unassigned.
  step('Opening Sift');
  await offCamera(async () => {
    await page.locator('.part.activitybar [aria-label^="Sift"]').first().click();
    await pause(800);
    await dragSash(150);
    await command('Sift: Plan commits manually');
    await pause(800);
    await command('Sift: Expand all');
    await pause(800);
    await command('Notifications: Clear All Notifications');
  });
  await caption(1, 'Your AI changed 9 files at once. Sift lists them in Unassigned.');
  await hold(4000);
  await screenshot('changes');

  // 2. One click: the AI plans the commits.
  step('Planning with AI');
  await caption(2, 'Click “Plan commits with AI”');
  await hold(1500);
  await titleButton('Plan commits with AI');
  await pause(1000);
  await screenshot('planning');
  await page.waitForSelector('.part.sidebar .monaco-list-row:has-text("Limit requests per client")', { timeout: 30_000 });
  await expandAll();
  await caption(2, 'The AI groups them into three small commits, in order');
  await hold(4000);
  await screenshot('plan');
  await clearNotifications();

  // 3. The diff, with the AI's explanations open on its lines.
  step('Opening a diff with explanations');
  await caption(3, 'Open a file: the AI explains the lines that matter');
  await row('server.ts').click();
  await page.waitForSelector('.monaco-diff-editor', { timeout: 15_000 });
  await pause(1200);
  await hidePanel();
  await goToLine(lineOf('src/server.ts', 'if (!allow(req, res))') + 6);
  await hold(3500);
  await screenshot('explanation');

  await row('rateLimit.ts').click();
  await pause(1200);
  await hidePanel();
  await goToLine(lineOf('src/middleware/rateLimit.ts', 'if (bucket.tokens < 1)') + 4);
  await hold(3500);
  await screenshot('explanations');

  // 4. Ask about a line: the answer lands in the same thread.
  step('Asking the AI about a line');
  await goToLine(lineOf('src/middleware/rateLimit.ts', 'const buckets = new Map'));
  await caption(4, 'Ask about any line');
  await offCamera(() => command('Comments: Add Comment on Current Selection'));
  await pause(800);
  await page.keyboard.type('Does this map grow forever when many clients call us?', { delay: 45 });
  await hold(1500);
  await screenshot('question');
  await page.keyboard.press('Meta+Enter'); // Ask AI
  await pause(1200);
  await screenshot('thinking');
  await page.getByText('It stays bounded').first().waitFor({ timeout: 30_000 });
  await hidePanel();
  await caption(4, 'The answer lands in the same thread');
  await hold(5000);
  await screenshot('answer');

  // 5. One file split across two commits: each part has its own diff.
  step('Showing a split file');
  await caption(5, 'One file, two commits: each part has its own diff');
  await row('2 of 3 changes').click();
  await pause(1200);
  await hidePanel();
  await hold(4000);
  await screenshot('split');

  // 6. Approve the first commit's files and commit it.
  step('Approving and committing');
  await caption(6, 'Approve the files of a commit…');
  await hold(1200);
  for (const text of ['format.ts', '1 of 3 changes', 'users.ts']) {
    await row(text).locator('.custom-view-tree-node-item-checkbox').click();
    await pause(700);
  }
  await hold(1500);
  await screenshot('approved');
  await caption(6, '…and commit them. The next commit goes into review.');
  await titleButton('Commit approved commits');
  await page.waitForSelector('.part.sidebar .monaco-list-row:has-text("Committed")', { timeout: 30_000 });
  await hold(4500);
  await screenshot('committed');
} catch (error) {
  await screenshot('error');
  console.error(error);
  process.exitCode = 1;
} finally {
  if (!keep) {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await app.close();
    saveVideo();
  }
}
