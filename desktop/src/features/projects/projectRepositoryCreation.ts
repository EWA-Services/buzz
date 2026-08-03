import type { Project } from "@/features/projects/hooks";
import {
  KIND_PROJECT_ANNOUNCEMENT,
  KIND_REPO_ANNOUNCEMENT,
} from "@/shared/constants/kinds";
import type { ProjectEventTemplate } from "./projectCreation";

export type AddedRepositoryEventTemplates = {
  project: ProjectEventTemplate;
  repository: ProjectEventTemplate;
  repositoryAddress: string;
  repositoryDtag: string;
};

function repositoryDtagFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildAddedRepositoryEventTemplates({
  cloneUrl,
  description,
  name,
  ownerPubkey,
  project,
  webUrl,
}: {
  cloneUrl?: string;
  description?: string;
  name: string;
  ownerPubkey: string;
  project: Project;
  webUrl?: string;
}): AddedRepositoryEventTemplates {
  const normalizedOwner = ownerPubkey.trim().toLowerCase();
  if (normalizedOwner !== project.owner.toLowerCase()) {
    throw new Error("Only the project owner can add repositories.");
  }

  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("Repository name is required.");
  const repositoryDtag = repositoryDtagFromName(normalizedName);
  if (!repositoryDtag) {
    throw new Error("Repository name must include letters or numbers.");
  }

  const repositoryAddress = `${KIND_REPO_ANNOUNCEMENT}:${normalizedOwner}:${repositoryDtag}`;
  const isUnavailableMember =
    project.unavailableRepositoryAddresses?.includes(repositoryAddress) ??
    false;
  if (
    project.repositoryAddresses.includes(repositoryAddress) &&
    !isUnavailableMember
  ) {
    throw new Error(`This project already contains "${repositoryDtag}".`);
  }
  if (!isUnavailableMember && project.repositoryAddresses.length >= 64) {
    throw new Error("A project cannot contain more than 64 repositories.");
  }

  const normalizedDescription = description?.trim() ?? "";
  const repositoryTags: string[][] = [
    ["d", repositoryDtag],
    ["name", normalizedName],
  ];
  if (normalizedDescription) {
    repositoryTags.push(["description", normalizedDescription]);
  }
  const normalizedCloneUrl = cloneUrl?.trim();
  if (normalizedCloneUrl) repositoryTags.push(["clone", normalizedCloneUrl]);
  const normalizedWebUrl = webUrl?.trim();
  if (normalizedWebUrl) repositoryTags.push(["web", normalizedWebUrl]);

  const projectTags: string[][] = [
    ["d", project.dtag],
    ["name", project.name],
  ];
  if (project.description) {
    projectTags.push(["description", project.description]);
  }
  if (project.projectChannelId) {
    projectTags.push(["buzz-channel", project.projectChannelId]);
  }
  if (project.visibility === "unlisted") {
    projectTags.push(["buzz-visibility", "unlisted"]);
  }
  for (const address of project.repositoryAddresses) {
    const relayHint = project.repositoryRelayHints?.[address];
    projectTags.push(relayHint ? ["a", address, relayHint] : ["a", address]);
  }
  if (!isUnavailableMember) {
    projectTags.push(["a", repositoryAddress]);
  }

  return {
    project: {
      kind: KIND_PROJECT_ANNOUNCEMENT,
      content: "",
      tags: projectTags,
    },
    repository: {
      kind: KIND_REPO_ANNOUNCEMENT,
      content: normalizedDescription,
      tags: repositoryTags,
    },
    repositoryAddress,
    repositoryDtag,
  };
}
