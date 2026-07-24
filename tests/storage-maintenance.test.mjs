import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("production storage maintenance keeps one prepared video copy and bounds logs", async () => {
  const [backup, cleanup, compose, deploy] = await Promise.all([
    readFile(new URL("scripts/backup-entrypoint.sh", root), "utf8"),
    readFile(new URL("scripts/cleanup-server-storage.sh", root), "utf8"),
    readFile(new URL("compose.yaml", root), "utf8"),
    readFile(new URL(".github/workflows/deploy.yml", root), "utf8"),
  ]);

  assert.match(backup, /--exclude='\.\/uploads\/\*\.source\.\*'/);
  assert.match(backup, /--exclude='\.\/uploads\/\*\.stream\.mp4'/);
  assert.match(backup, /grep -q '"media"' "\$manifest"/);
  assert.match(backup, /if ! \/bin\/sh "\$0" prune-media/);
  assert.match(backup, /! -name '\*\.stream\.mp4' -exec rm -rf -- \{\} \+/);
  assert.match(cleanup, /if \[ ! -s "\$prepared_path" \]/);
  assert.match(cleanup, /rm -f -- "\$source_path"/);
  assert.doesNotMatch(cleanup, /docker volume prune/);
  assert.match(compose, /max-size: "\$\{DOCKER_LOG_MAX_SIZE:-10m\}"/);
  assert.match(compose, /max-file: "\$\{DOCKER_LOG_MAX_FILES:-3\}"/);
  assert.equal((compose.match(/logging: \*default-logging/g) || []).length, 7);
  assert.match(deploy, /backup prune-media/);
  assert.match(deploy, /cleanup-server-storage\.sh cleanup/);
  assert.doesNotMatch(deploy, /docker volume prune/);
});
