import assert from "node:assert/strict";
import test from "node:test";

import { buildAddedRepositoryEventTemplates } from "./projectRepositoryCreation.ts";

const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);

const project = {
  id: `${OWNER}:buzz`,
  dtag: "buzz",
  name: "Buzz",
  description: "A multi-repository workspace",
  owner: OWNER,
  createdAt: 1,
  projectChannelId: "11111111-1111-4111-8111-111111111111",
  status: "active",
  projectAddress: `30621:${OWNER}:buzz`,
  primaryRepositoryAddress: `30617:${OWNER}:desktop`,
  repositoryAddresses: [`30617:${OWNER}:desktop`, `30617:${OTHER_OWNER}:relay`],
  repositoryRelayHints: {
    [`30617:${OTHER_OWNER}:relay`]: "wss://relay.example",
  },
  repositories: [],
  unavailableRepositoryAddresses: [],
  visibility: "listed",
  legacy: false,
};

test("buildAddedRepositoryEventTemplates preserves NIP-MP project metadata and membership", () => {
  const templates = buildAddedRepositoryEventTemplates({
    project,
    ownerPubkey: OWNER,
    name: "Mobile App",
    description: "Flutter client",
    cloneUrl: "https://relay.example/git/mobile-app.git",
  });

  assert.equal(templates.repository.kind, 30617);
  assert.deepEqual(templates.repository.tags, [
    ["d", "mobile-app"],
    ["name", "Mobile App"],
    ["description", "Flutter client"],
    ["clone", "https://relay.example/git/mobile-app.git"],
  ]);
  assert.equal(templates.project.kind, 30621);
  assert.deepEqual(templates.project.tags, [
    ["d", "buzz"],
    ["name", "Buzz"],
    ["description", "A multi-repository workspace"],
    ["buzz-channel", "11111111-1111-4111-8111-111111111111"],
    ["a", `30617:${OWNER}:desktop`],
    ["a", `30617:${OTHER_OWNER}:relay`, "wss://relay.example"],
    ["a", `30617:${OWNER}:mobile-app`],
  ]);
  assert.equal(templates.project.content, "");
});

test("buildAddedRepositoryEventTemplates rejects updates by another owner", () => {
  assert.throws(
    () =>
      buildAddedRepositoryEventTemplates({
        project,
        ownerPubkey: OTHER_OWNER,
        name: "Mobile",
      }),
    /Only the project owner/,
  );
});
