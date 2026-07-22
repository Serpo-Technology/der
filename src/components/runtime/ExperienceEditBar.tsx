/**
 * Edit bar for live experiences: type a change, the app updates in place.
 */

import React, { useCallback, useMemo, useState } from 'react';
import type { ValidationWarning } from '../../types/contract';

interface ExperienceEditBarProps {
  onSubmit: (instruction: string) => Promise<void>;
  busy: boolean;
  warnings?: ValidationWarning[];
  onDismissWarnings?: () => void;
}

interface WarningGroup {
  title: string;
  singular: string;
  plural: string;
  entries: ValidationWarning[];
}

/**
 * Notes come in three kinds with different meanings: adjustments the
 * validator applied, assumptions the model recorded, and open questions it
 * raised. Grouping keeps them from reading as one undifferentiated count.
 */
function groupWarnings(warnings: ValidationWarning[]): WarningGroup[] {
  const groups: WarningGroup[] = [
    { title: 'Adjustments', singular: 'adjustment', plural: 'adjustments', entries: [] },
    { title: 'Assumptions', singular: 'assumption', plural: 'assumptions', entries: [] },
    { title: 'Open questions', singular: 'open question', plural: 'open questions', entries: [] }
  ];
  for (const warning of warnings) {
    if (warning.code === 'SPEC_ASSUMPTION') groups[1].entries.push(warning);
    else if (warning.code === 'SPEC_QUESTION') groups[2].entries.push(warning);
    else groups[0].entries.push(warning);
  }
  return groups.filter((group) => group.entries.length > 0);
}

/** A lone note has no group heading, so it carries its kind inline. */
function labelWarning(warning: ValidationWarning): string {
  if (warning.code === 'SPEC_ASSUMPTION') return `Assumed: ${warning.message}`;
  if (warning.code === 'SPEC_QUESTION') return `Open question: ${warning.message}`;
  return warning.message;
}

interface ExperienceNotesProps {
  warnings: ValidationWarning[];
  onDismiss?: () => void;
}

/**
 * Build notes for an experience: adjustments the validator applied, plus the
 * assumptions and open questions the model recorded. Shown under the edit bar
 * and in the create view after an app opens.
 */
export const ExperienceNotes: React.FC<ExperienceNotesProps> = ({ warnings, onDismiss }) => {
  const groups = useMemo(() => groupWarnings(warnings), [warnings]);
  if (warnings.length === 0) return null;

  if (warnings.length === 1) {
    return (
      <div className="der-edit-warnings">
        <span className="der-edit-warnings-single">{labelWarning(warnings[0])}</span>
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss warnings">
            Dismiss
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="der-edit-warnings">
      <details>
        <summary>
          {groups
            .map((group) =>
              `${group.entries.length} ${
                group.entries.length === 1 ? group.singular : group.plural
              }`
            )
            .join(', ')}
        </summary>
        {groups.map((group) => (
          <div key={group.title} className="der-warning-group">
            <div className="der-warning-group-title">{group.title}</div>
            <ul>
              {group.entries.map((warning, index) => (
                <li key={`${group.title}-${index}`}>{warning.message}</li>
              ))}
            </ul>
          </div>
        ))}
      </details>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss warnings">
          Dismiss
        </button>
      )}
    </div>
  );
};

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
        <ExperienceNotes warnings={warnings} onDismiss={onDismissWarnings} />
      )}
    </div>
  );
};

export default ExperienceEditBar;
