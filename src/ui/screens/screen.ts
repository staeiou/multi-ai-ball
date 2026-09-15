import type { AppData } from '../store'

export interface Screen {
  el: HTMLElement
  /** Re-render derived regions from the store. Inputs are left alone. */
  refresh(data: AppData): void
  /** Write persisted values back into inputs (after a template load or a restore). */
  restore?(data: AppData): void
}
