/**
 * Edit bar for live experiences: type a change, the app updates in place.
 */

import React, { useCallback, useState } from 'react';
import type { ValidationWarning } from '../../types/contract';

interface ExperienceEditBarProps {
  onSubmit: (instruction: string) => Promise<void>;
  busy: boolean;
  warnings?: ValidationWarning[];
  onDismissWarnings?: () => void;
}

export const ExperienceEditBar: React.FC<ExperienceEditBarProps> = ({
  onSubmit,
  busy,
  warnings,
  onDismissWarnings
}) => {
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = instruction.trim();
      if (!trimmed || busy) return;
      setError(null);
      try {
        await onSubmit(trimmed);
        setInstruction('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The change could not be applied');
      }
    },
    [instruction, busy, onSubmit]
  );

  return (
    <div className="der-edit-bar">
      <form onSubmit={handleSubmit} className="der-edit-form">
        <input
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Describe a change, e.g. add a category dropdown"
          disabled={busy}
          aria-label="Describe a change"
        />
        <button type="submit" disabled={busy || !instruction.trim()}>
          {busy ? 'Updating...' : 'Apply'}
        </button>
      </form>
      {error && <div className="der-edit-error">{error}</div>}
      {warnings && warnings.length > 0 && (
        <div className="der-edit-warnings">
          <span>
            {warnings.length === 1
              ? warnings[0].message
              : `${warnings.length} adjustments were made to fit the available parts`}
          </span>
          {onDismissWarnings && (
            <button type="button" onClick={onDismissWarnings} aria-label="Dismiss warnings">
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ExperienceEditBar;
