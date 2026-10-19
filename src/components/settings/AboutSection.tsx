/**
 * Shows the author credit, copyright line, and license notices in Settings.
 */

import React, { useCallback } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauriRuntime } from '../../services/tauri/TauriCommandService';

const REPOSITORY_URL = 'https://github.com/Serpo-Technology/der';
const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
const NOTICE_URL = `${REPOSITORY_URL}/blob/main/NOTICE`;

export const AboutSection: React.FC = () => {
  // The desktop shell hands links to the default browser; a plain browser
  // follows them itself.
  const handleLink = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isTauriRuntime()) return;
    event.preventDefault();
    openUrl(event.currentTarget.href).catch(() => undefined);
  }, []);

  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleLink}>
      {label}
    </a>
  );

  // The attribution sentence and its link are the text NOTICE requires every
  // copy and modified version to preserve.
  return (
    <section className="settings-section settings-about">
      <h3>About DER</h3>
      <p>
        DER (Dynamic Experience Runtime) was originally created by Seyit Gokce.
        <br />
        {link(REPOSITORY_URL, REPOSITORY_URL)}
      </p>
      <p>Copyright (C) 2025-2026 Serpo Technology Inc.</p>
      <p>
        DER is free software: you can share and modify it under the GNU Affero General
        Public License, version 3 or later, with additional terms. DER comes with no
        warranty.
      </p>
      <p className="settings-about-links">
        {link(LICENSE_URL, 'License')}
        {link(NOTICE_URL, 'Additional terms')}
        {link(REPOSITORY_URL, 'Source code')}
      </p>
    </section>
  );
};

export default AboutSection;
