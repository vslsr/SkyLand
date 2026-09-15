import '../ui/scrollbars.css';
import './admin.css';
import { AdminConsole } from './AdminConsole';

const root = document.getElementById('admin-root');
if (!root) throw new Error('缺少 #admin-root 容器');

void new AdminConsole(root).start();
