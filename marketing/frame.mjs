// Frames the screenshots from capture.mjs for the README, the Marketplace and the website: each one
// on Sift's paper background with a headline. Renders with Chrome into out/framed/.
//
//   npm run frame
import { mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const framed = path.join(out, 'framed');
const logo = readFileSync(path.join(here, '..', 'resources', 'logo', 'sift-paper.svg'), 'utf8');

/** Which screenshot, and what it says. Edit the words here. */
export const SLIDES = [
  {
    name: 'plan',
    shot: '03-plan.png',
    title: 'Turn one giant diff into reviewed commits',
    text: 'The AI groups your changes into small, ordered commits, with notes on what matters.',
  },
  {
    name: 'explain',
    shot: '05-explanations.png',
    title: 'Every change, explained where it happens',
    text: 'Notes from the AI sit on the lines that carry intent or risk, in VS Code’s own diff.',
  },
  {
    name: 'ask',
    shot: '08-answer.png',
    title: 'Ask about any line',
    text: 'Questions and change requests go to the AI of your choice. The answer lands in the thread.',
  },
  {
    name: 'split',
    shot: '09-split.png',
    title: 'One file, two commits',
    text: 'Split a file’s changes across commits, each part with its own diff and approval.',
  },
  {
    name: 'commit',
    shot: '11-committed.png',
    title: 'Approve, commit, push',
    text: 'Sift commits exactly what you approved, with your own git identity and hooks.',
  },
];

const W = 1600;
const H = 1000;

function page(slide) {
  const shot = `data:image/png;base64,${readFileSync(path.join(out, slide.shot)).toString('base64')}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face { font-family: Inter; src: local('Inter'), local('Inter Regular'); }
  :root { --paper: #f5f4f0; --sand: #dcd7ce; --stone: #9a948a; --slate: #5c5752; --ink: #1e1c1a; --accent: #c2410c; }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden; position: relative;
    background: radial-gradient(1200px 700px at 85% 110%, #ead9c8 0%, rgba(234,217,200,0) 60%), var(--paper);
    font-family: Inter, -apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif; color: var(--ink);
  }
  /* Text flows, so a headline on two lines pushes the subtitle and the screenshot down. */
  .stack { position: absolute; left: 88px; top: 72px; right: 88px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 14px; font-weight: 600; font-size: 26px; letter-spacing: -0.01em; }
  .brand svg { width: 44px; height: 44px; }
  h1 { margin-top: 34px; max-width: 1300px; font-size: 64px; line-height: 1.05; letter-spacing: -0.035em; font-weight: 700; text-wrap: balance; }
  p { margin-top: 18px; margin-left: 2px; max-width: 1000px; font-size: 26px; line-height: 1.4; color: var(--slate); }
  .shot {
    margin-top: 44px; flex: none; width: 1420px; height: 799px;
    border-radius: 16px; overflow: hidden; background: #1e1e1e;
    box-shadow: 0 1px 0 rgba(255,255,255,.6) inset, 0 40px 80px -20px rgba(30,28,26,.45), 0 0 0 1px rgba(30,28,26,.12);
  }
  .shot img { width: 100%; height: 100%; display: block; }
  .dot { color: var(--accent); }
</style></head><body>
  <div class="stack">
    <div class="brand">${logo}<span>Sift</span></div>
    <h1>${slide.title}<span class="dot">.</span></h1>
    <p>${slide.text}</p>
    <div class="shot"><img src="${shot}"></div>
  </div>
</body></html>`;
}

mkdirSync(framed, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const tab = await context.newPage();
for (const slide of SLIDES) {
  await tab.setContent(page(slide), { waitUntil: 'load' });
  const file = path.join(framed, `${slide.name}.png`);
  await tab.screenshot({ path: file });
  console.log(`· Saved ${path.relative(here, file)}`);
}
await browser.close();
