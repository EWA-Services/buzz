import * as React from "react";
import { toast } from "sonner";

import type { Project, Repository } from "@/features/projects/hooks";
import { useAddProjectRepositoryMutation } from "@/features/projects/useAddProjectRepository";
import { useAttachProjectRepositoryMutation } from "@/features/projects/useAttachProjectRepository";
import { AddProjectRepositoryDialog } from "./AddProjectRepositoryDialog";
import { AttachProjectRepositoryDialog } from "./AttachProjectRepositoryDialog";
import { ProjectRepositoryPicker } from "./ProjectRepositoryPicker";

export function ProjectRepositoryManagement({
  identityPubkey,
  onChange,
  project,
  projects,
  repository,
}: {
  identityPubkey?: string;
  onChange: (repositoryId: string) => void;
  project: Project;
  projects: Project[];
  repository: Repository;
}) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [attachOpen, setAttachOpen] = React.useState(false);
  const createMutation = useAddProjectRepositoryMutation();
  const attachMutation = useAttachProjectRepositoryMutation();
  const canEdit = identityPubkey?.toLowerCase() === project.owner.toLowerCase();
  const attachCandidates = React.useMemo(() => {
    const currentAddresses = new Set(project.repositoryAddresses);
    const candidates = new Map<string, Repository>();
    for (const candidateProject of projects) {
      for (const candidate of candidateProject.repositories) {
        if (!currentAddresses.has(candidate.repoAddress)) {
          candidates.set(candidate.repoAddress, candidate);
        }
      }
    }
    return [...candidates.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [project.repositoryAddresses, projects]);

  return (
    <>
      <AddProjectRepositoryDialog
        isCreating={createMutation.isPending}
        onAdd={async (input) => {
          const result = await createMutation.mutateAsync(input);
          onChange(result.repository.id);
          toast.success(`Repository "${result.repository.name}" created.`);
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
        project={project}
      />
      <AttachProjectRepositoryDialog
        isAttaching={attachMutation.isPending}
        onAttach={async (candidate) => {
          const result = await attachMutation.mutateAsync({
            project,
            repository: candidate,
          });
          onChange(result.repository.id);
          toast.success(`Repository "${result.repository.name}" added.`);
        }}
        onOpenChange={setAttachOpen}
        open={attachOpen}
        project={project}
        repositories={attachCandidates}
      />
      <ProjectRepositoryPicker
        onAttach={canEdit ? () => setAttachOpen(true) : undefined}
        onChange={onChange}
        onCreate={canEdit ? () => setCreateOpen(true) : undefined}
        project={project}
        repository={repository}
      />
    </>
  );
}
