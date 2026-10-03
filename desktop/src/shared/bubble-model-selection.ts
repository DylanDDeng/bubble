/** Used by both the composer and the desktop adapter before starting a turn. */
export function bubbleModelSelectionError(
  model: string | null | undefined,
  availableModels: readonly string[],
): string | null {
  if (availableModels.length === 0) {
    return 'No Bubble models available. Load models in Settings → Providers before sending.';
  }
  if (!model?.trim()) return 'Select a Bubble model before sending.';
  if (!availableModels.includes(model.trim())) {
    return 'The selected Bubble model is no longer available. Select an available model before sending.';
  }
  return null;
}
