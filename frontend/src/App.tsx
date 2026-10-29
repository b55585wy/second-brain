import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { TodayPage } from './pages/TodayPage';
import { PlanPage } from './pages/PlanPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { CodexPage } from './pages/CodexPage';
import { ReviewPage } from './pages/ReviewPage';
import { PracticePage } from './pages/PracticePage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  return <Routes><Route element={<Layout />}>
    <Route index element={<TodayPage />} />
    <Route path="projects" element={<ProjectsPage />} />
    <Route path="projects/:id" element={<ProjectDetailPage />} />
    <Route path="knowledge" element={<KnowledgePage />} />
    <Route path="codex" element={<CodexPage />} />
    <Route path="review" element={<ReviewPage />} />
    <Route path="practice" element={<PracticePage />} />
    <Route path="plan" element={<PlanPage />} />
    <Route path="settings" element={<SettingsPage />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route></Routes>;
}
