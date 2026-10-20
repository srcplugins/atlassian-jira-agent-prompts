import React from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { FieldRoot } from './field-root';
import './field.css';

void view.theme.enable().catch(() => {});
createRoot(document.getElementById('root')!).render(<FieldRoot />);
