// Dev helper (not shipped): fills the throwaway test vault with fixture notes.
// Only writes the files it creates (overwriting them); never deletes anything.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VAULT = "/home/sspaeti/git/obsidian/trouble-tags-testvault";
let created = 0;

function write(rel, content) {
	const p = join(VAULT, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
	created++;
}

const allForms = `---
title: All forms
tags: TODO
---

# All forms

Every line below exercises one matching rule.

## Keywords

TODO: plain keyword with colon
#TODO hashtag keyword
(TODO: why?)
## TODO's
TODO
a note about todos
TODOS and MYTODO
TODO one and FIXME two
~~TODO~~ struck keyword is done
~~TODO: call bank~~
IDEA: try this
TK placeholder
BUG: crash on save
WARN: careful here

> [!NOTE] callout header is not a hit
> body of the callout

\`\`\`
TODO inside a code fence
\`\`\`

## List callouts

- ? why?
* ! important
+ = idea
1. ! ordered
2) $ money
-? no space after dash
- ?no space after char

## Tasks

- [ ] buy milk
- [x] bought
- [X] bought uppercase
- [ ] ? question task
- [ ] TODO: call bank
- ! TODO later
`;

const strike = `# Strike forms

~~TODO~~ marked done by the panel
~~#FIXME~~ hashtag marked done
~~TODO: call bank~~
~~fix TODO later~~ x
~~TODO fix this unpaired
TODO: still open
- [x] done task
- [ ] open task
`;

write("fixtures/all-forms.md", allForms);
write("fixtures/strike.md", strike);
write("templates/excluded.md", "TODO: should not appear when templates is excluded\n");

// The three notes the earlier manual checks used.
write("fixtures/task5-smoke.md", `TODO: first
#FIXME second
- ? question
- = question
- [ ] task line
- [x] done task
~~NOTE~~ struck
plain text
IDEA: try this
TK placeholder
`);
write("fixtures/vault-a.md", "~~TODO~~: alpha\n- [ ] beta\n");
write("fixtures/vault-b.md", "NOTE: gamma\nFIXME: delta\n");

// Deterministic pseudo-random so reruns produce the same vault.
let seed = 42;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) % 4294967296;
	return seed / 4294967296;
};
const LOREM = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");
const sentence = () => {
	const n = 6 + Math.floor(rnd() * 8);
	const words = [];
	for (let i = 0; i < n; i++) words.push(LOREM[Math.floor(rnd() * LOREM.length)]);
	return words.join(" ") + ".";
};
const HIT_LINES = [
	(i) => `TODO: follow up on item ${i}`,
	(i) => `- ? open question ${i}`,
	(i) => `- [ ] task ${i}`,
];

let generated = 0;
for (let n = 1; n <= 300; n++) {
	const lines = [];
	for (let l = 0; l < 40; l++) lines.push(sentence());
	const hits = Math.floor(rnd() * 4);
	for (let h = 0; h < hits; h++) {
		const at = Math.floor(rnd() * lines.length);
		lines[at] = HIT_LINES[Math.floor(rnd() * HIT_LINES.length)](n * 10 + h);
	}
	write(`generated/note-${String(n).padStart(3, "0")}.md`, lines.join("\n") + "\n");
	generated++;
}

console.log(`wrote ${created} files under ${VAULT}`);
