import React from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { Field } from './field';
import './field.css';

void view.theme.enable().catch(() => {});
createRoot(document.getElementById('root')!).render(<Field />);
