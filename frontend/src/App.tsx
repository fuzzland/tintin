import { Routes, Route, Navigate } from "react-router-dom";
import RunListPage from "./components/RunListPage";
import RunDetailPage from "./components/RunDetailPage";
import { useAuthToken } from "./hooks/useAuthToken";

export default function App() {
  const token = useAuthToken();

  if (!token) {
    return (
      <div className="page">
        <div className="error-banner">Missing access token. Use the shared link from Slack/Telegram.</div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<RunListPage token={token} />} />
      <Route path="/run/:runId" element={<RunDetailPage token={token} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
