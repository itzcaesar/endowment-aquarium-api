export function publicDonorName(displayName: string | null, showNamePublicly: boolean): string {
  return showNamePublicly && displayName ? displayName : 'Anonymous Donor';
}

export function toPublicDonor(input: {
  displayName: string | null;
  showNamePublicly: boolean;
  email?: string | null;
}) {
  return {
    displayName: publicDonorName(input.displayName, input.showNamePublicly),
  };
}
