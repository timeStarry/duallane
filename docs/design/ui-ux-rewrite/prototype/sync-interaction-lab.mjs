import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const lucide = require('lucide-react');
const chevron = renderToStaticMarkup(React.createElement(lucide.ChevronDown, { size: 16, 'aria-hidden': true }));
const read = name => readFile(new URL(name, import.meta.url), 'utf8');
let report = await read('index.html');
const icons = Object.fromEntries(['MoreHorizontal', 'Reply', 'Pin', 'EyeOff', 'Undo2', 'Bell', 'ChevronRight', 'Shield', 'UserRound', 'Palette'].map(name => [name, renderToStaticMarkup(React.createElement(lucide[name], { size: 18, className: 'ico', 'aria-hidden': true, focusable: false }))]));
const parts = [
  ['style', `/* INTERACTION LAB START */\n${(await read('interaction-lab.css')).trim()}\n/* INTERACTION LAB END */`, /\/\* INTERACTION LAB START \*\/[\s\S]*?\/\* INTERACTION LAB END \*\//, '</style>'],
  ['markup', `<!-- INTERACTION LAB START -->\n${(await read('interaction-lab.html')).trim()}\n<!-- INTERACTION LAB END -->`, /<!-- INTERACTION LAB START -->[\s\S]*?<!-- INTERACTION LAB END -->/, '<section id="components"'],
  ['script', `<!-- INTERACTION LAB SCRIPT START -->\n<script>\nObject.assign(ICONS,${JSON.stringify(icons)});\n${(await read('interaction-lab.js')).trim()}\n</script>\n<!-- INTERACTION LAB SCRIPT END -->`, /<!-- INTERACTION LAB SCRIPT START -->[\s\S]*?<!-- INTERACTION LAB SCRIPT END -->/, '</body>']
];
parts.push(
  ['control style', `/* CONTROL STYLE START */\n:root{--control-chevron:url("data:image/svg+xml,${encodeURIComponent(chevron)}")}\n${(await read('controls.css')).trim()}\n/* CONTROL STYLE END */`, /\/\* CONTROL STYLE START \*\/[\s\S]*?\/\* CONTROL STYLE END \*\//, '</style>'],
  ['control markup', `<!-- CONTROL LAB START -->\n${(await read('controls-lab.html')).trim()}\n<!-- CONTROL LAB END -->`, /<!-- CONTROL LAB START -->[\s\S]*?<!-- CONTROL LAB END -->/, '<div class="component-grid">'],
  ['selection style', `/* SELECTION STYLE START */\n${(await read('selection.css')).trim()}\n/* SELECTION STYLE END */`, /\/\* SELECTION STYLE START \*\/[\s\S]*?\/\* SELECTION STYLE END \*\//, '</style>'],
  ['selection markup', `<!-- SELECTION LAB START -->\n${(await read('selection-lab.html')).trim()}\n<!-- SELECTION LAB END -->`, /<!-- SELECTION LAB START -->[\s\S]*?<!-- SELECTION LAB END -->/, '<div class="component-grid">']
);
for (const [name, content, marker, before] of parts) {
  if (marker.test(report)) report = report.replace(marker, () => content);
  else if (report.includes(before)) report = report.replace(before, () => `${content}\n${before}`);
  else throw new Error(`Missing insertion point: ${name}`);
}
if (!report.includes('href="#context-actions"')) {
  report = report.replace('<a href="#components">', '<a href="#context-actions"><span class="nav-num">05</span>右键与长按</a><a href="#personal-settings"><span class="nav-num">06</span>个人设置</a><a href="#components">');
  report = report.replace('05</span>组件实验室', '07</span>组件实验室').replace('06</span>多端架构', '08</span>多端架构').replace('07</span>全量重构', '09</span>全量重构');
  report = report.replace('05 / COMPONENTS', '07 / COMPONENTS').replace('06 / ADAPTIVE', '08 / ADAPTIVE').replace('07 / COMPLETE', '09 / COMPLETE');
}
const target = new URL('index.html', import.meta.url);
if (process.argv.includes('--check')) {
  const checkedIn = await read('index.html');
  if (report.replaceAll('\r\n', '\n') !== checkedIn.replaceAll('\r\n', '\n')) throw new Error('Interaction sources are not synchronized; run this script without --check.');
  console.log('PASS: interaction lab sources match the self-contained report.');
} else {
  await writeFile(target, report);
  console.log('Updated the self-contained report from interaction lab sources.');
}
