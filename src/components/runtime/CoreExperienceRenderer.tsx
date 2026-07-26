/**
 * The webview face as a protocol client: the runtime core owns the session
 * (state, operations, resolution) and this component renders the resolved
 * trees it answers with, through the same React presentation the local
 * renderer uses. Element writes and event chains go to the core in user
 * order; timers tick renderer-side off the tree's event tables, exactly
 * like the native panel.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './experience.css';
import { Contract } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
import { ComponentRenderer } from './ComponentRenderer';
import type { EventContext } from './OperationExecutor';
import { CoreSessionClient } from '../../services/runtime-core/session-client';
import type { ResolvedNode } from '../../services/runtime-view/resolve-view';
import { STYLE_ACCENTS, STYLE_THEMES } from '../../services/operations/registry';
import {
  backgroundVariables,
  hexAccentVariables,
  isHexAccent,
} from '../../services/operations/accent-color';
import MailAccountForm from '../settings/MailAccountForm';

interface CoreExperienceRendererProps {
  contract: Contract;
  experienceId: string;
  /** Previously saved state data, merged over the contract's seeds. */
  initialData?: Record<string, unknown>;
  onStateChange?: (state: ExperienceState) => void;
  onError?: (error: Error) => void;
}

/** Session state map -> the shape the window's persistence expects. */
function asExperienceState(data: Record<string, unknown>): ExperienceState {
  return { data, loading: {}, errors: {}, lastUpdated: new Date() };
}

/** Local control values win over async echoes while the user types; a
 * dispatch outcome (where resets and routed outputs land) clears them. */
function overlayControls(
  nodes: ResolvedNode[],
  overlay: Map<string, unknown>
): ResolvedNode[] {
  if (overlay.size === 0) return nodes;
  return nodes.map((node) => {
    const patched: ResolvedNode = { ...node };
    if (node.control && overlay.has(node.id)) {
      patched.control = { ...node.control, value: overlay.get(node.id) };
    }
    if (node.children?.length) {
      patched.children = overlayControls(node.children, overlay);
    }
    if (node.rows?.length) {
      patched.rows = node.rows.map((row) => ({
        ...row,
        children: overlayControls(row.children, overlay),
      }));
    }
    return patched;
  });
}

export const CoreExperienceRenderer: React.FC<CoreExperienceRendererProps> = ({
  contract,
  experienceId,
  initialData,
  onStateChange,
  onError,
}) => {
  const client = useMemo(() => new CoreSessionClient(), []);
  const componentRenderer = useMemo(() => new ComponentRenderer(), []);
  const [tree, setTree] = useState<ResolvedNode[]>([]);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [showMailSetup, setShowMailSetup] = useState(false);
  const dismissedErrorRef = useRef<string | null>(null);
  const overlayRef = useRef(new Map<string, unknown>());
  // The freshest state map, carried into the next session when the contract
  // changes (edits, streamed drafts) so data survives the swap.
  const lastStateRef = useRef<Record<string, unknown>>(initialData ?? {});
  const [, forceRender] = useState(0);

  useEffect(() => {
    let cancelled = false;
    client
      .open(contract, lastStateRef.current, experienceId)
      .then((opened) => {
        if (cancelled) return;
        overlayRef.current = new Map();
        lastStateRef.current = opened.state;
        setTree(opened.tree);
        onStateChange?.(asExperienceState(opened.state));
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setOperationError(`This app could not open: ${message}`);
        onError?.(error instanceof Error ? error : new Error(message));
      });
    return () => {
      cancelled = true;
    };
    // Reopen only when the contract identity or app changes; state carries.
  }, [client, contract, experienceId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      void client.close();
    };
  }, [client]);

  const handleOperationExecution = useCallback(
    async (operationId: string, eventContext: EventContext) => {
      const outcome = await client.dispatch([operationId], eventContext.item ?? null);
      if (!outcome) return;
      overlayRef.current = new Map();
      lastStateRef.current = outcome.state;
      setTree(outcome.tree);
      onStateChange?.(asExperienceState(outcome.state));
      if (outcome.failed) {
        const message = outcome.error ?? `Operation ${outcome.failed} failed`;
        if (dismissedErrorRef.current !== message) {
          setOperationError(message);
        }
        onError?.(new Error(message));
        // Chains stop at the first failure; the caller's loop needs the
        // throw, the error is already displayed above.
        throw new Error(message);
      }
      setOperationError(null);
    },
    [client, onStateChange, onError]
  );

  const setElementValue = useCallback(
    (elementId: string, value: unknown) => {
      overlayRef.current.set(elementId, value);
      forceRender((count) => count + 1);
      void client
        .setElement(elementId, value)
        .then((fresh) => {
          if (fresh) setTree(fresh);
        })
        .catch(() => undefined);
    },
    [client]
  );

  // App-level look from the contract; unknown values fall back to default.
  const styling = (contract.styling ?? { theme: 'default' }) as {
    theme?: string;
    accent?: string;
    background?: string;
  };
  const theme = (STYLE_THEMES as readonly string[]).includes(styling.theme ?? '')
    ? styling.theme
    : 'default';
  const accent =
    styling.accent && (STYLE_ACCENTS as readonly string[]).includes(styling.accent)
      ? styling.accent
      : undefined;
  const hexAccent =
    !accent && styling.accent && isHexAccent(styling.accent) ? styling.accent : undefined;
  const hexBackground =
    styling.background && isHexAccent(styling.background) ? styling.background : undefined;
  const layout = contract.layout ?? { type: 'flex' as const, properties: {} };
  const containerStyles: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: layout.type === 'grid' ? 'grid' : 'flex',
    ...(layout.type === 'absolute' ? { position: 'relative' } : {}),
    ...(layout.properties as React.CSSProperties),
    ...(hexAccent ? hexAccentVariables(hexAccent) : undefined),
    ...(hexBackground ? backgroundVariables(hexBackground) : undefined),
  };
  const containerClassName = [
    'dynamic-experience-container',
    `der-theme-${theme}`,
    accent ? `der-accent-${accent}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const visible = overlayControls(tree, overlayRef.current);

  return (
    <div
      className={containerClassName}
      style={containerStyles}
      data-experience-id={experienceId}
      data-contract-name={contract.name}
      data-testid="core-experience-container"
    >
      {operationError && (
        <div className="der-operation-error" role="alert">
          <span>{operationError}</span>
          {operationError.includes('Email is not set up') && (
            <button type="button" onClick={() => setShowMailSetup(true)}>
              Set up email
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              dismissedErrorRef.current = operationError;
              setOperationError(null);
            }}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}
      {showMailSetup && (
        <div className="mail-account-overlay">
          <div className="mail-account-dialog">
            <h3>Mail account</h3>
            <MailAccountForm
              onSaved={() => {
                setShowMailSetup(false);
                setOperationError(null);
              }}
              onCancel={() => setShowMailSetup(false)}
            />
          </div>
        </div>
      )}
      {visible.map((node) => (
        <React.Fragment key={node.id}>
          {componentRenderer.renderResolvedNode(node, handleOperationExecution, {
            setElementValue,
          })}
        </React.Fragment>
      ))}
    </div>
  );
};

export default CoreExperienceRenderer;
