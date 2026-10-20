import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDarwinUsedBytes } from "./sampler.ts";

for (const pageSize of [4096, 16384]) {
  test(`macOS memory excludes cache and counts physical compression (${pageSize}-byte pages)`, () => {
    const raw = `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free:                                    200.
Pages wired down:                              300.
Pages purgeable:                               100.
File-backed pages:                            2000.
Anonymous pages:                              1000.
Pages stored in compressor:                    800.
Pages occupied by compressor:                  200.
`;
    assert.equal(parseDarwinUsedBytes(raw), 1400 * pageSize);
  });
}

test("incomplete vm_stat output reports the missing field instead of undercounting", () => {
  assert.throws(() => parseDarwinUsedBytes(""), /missing page size/);
  assert.throws(
    () => parseDarwinUsedBytes("Mach Virtual Memory Statistics: (page size of 16384 bytes)"),
    /missing Anonymous pages/,
  );
});
