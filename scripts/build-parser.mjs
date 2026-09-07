// Regenerates src/parser2.js from src/parser2.peg.
//
// `format: "bare"` emits the parser as a bare expression, which is why the
// generated file reads `export default (function(){...})();` -- the same shape
// it has always had, so nothing importing it has to change.
//
// The header below is the only documentation of the rhythm syntax that ships
// with the parser, so it is regenerated with it rather than living in a file
// that can drift.
import { readFileSync, writeFileSync } from "fs";
import peggy from "peggy";

const HEADER = `/*
 GENERATED FILE -- do not edit. Source: src/parser2.peg
 Regenerate with: yarn build:parser

 Works on syntax like [[k 1>-.1, h 1, s 1]:1, 3:1, 1]: 1

   4              one note, span of 4 beats
   2:1            2 evenly spaced notes across 1 beat
   1/5            one note, span of 0.2 -- the grammar does arithmetic
   [2:1, 1]:1     a group; entries share the span given after the "]"
   [k 1, h 1]:1   sounds: a letter (h k r s) then a weight
   [h 1>-.1]:1    ">" nudges that note's time -- lands at 0.9, not 0
   [k 1, h 1]x4   repeat the group four times
   [k 1, h 1]x4:1 repeat, then squish the whole run into one beat

 Returns output like:
 {
  "notes": [ { "time": 0.111, "sounds": ["h"] } ],
  "start": 0,
  "end": 1
 }
*/

`;

const grammar = readFileSync(new URL("../src/parser2.peg", import.meta.url), "utf8");
const source = peggy.generate(grammar, { output: "source", format: "bare" });
writeFileSync(
  new URL("../src/parser2.js", import.meta.url),
  `${HEADER}export default ${source};\n`
);
console.log("wrote src/parser2.js");
