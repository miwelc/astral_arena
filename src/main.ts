import './styles.css';
import { AstralArenaApp } from './app/AstralArenaApp';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('No se encontró #app.');

new AstralArenaApp(root);
