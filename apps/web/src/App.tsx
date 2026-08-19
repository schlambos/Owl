import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { SchemaStatusBanner } from "./components/SchemaStatusBanner";
import { ThemeProvider } from "./components/layout/ThemeProvider";
import { OverviewPage } from "./pages/OverviewPage";
import { ModelsPage } from "./pages/ModelsPage";
import { AgentsPage } from "./pages/AgentsPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { ProviderManagementPage } from "./pages/ProviderManagementPage";
import { AddProviderPage } from "./pages/AddProviderPage";
import { ProviderEditPage } from "./pages/ProviderEditPage";
import { ProviderBlacklistPage } from "./pages/ProviderBlacklistPage";
import { SessionsPage } from "./pages/SessionsPage";
import { ConfigPage } from "./pages/ConfigPage";
import { CapabilitiesPage } from "./pages/CapabilitiesPage";
import { PromptsPage } from "./pages/PromptsPage";
import { PresetsPage } from "./pages/PresetsPage";
import { SystemPage } from "./pages/SystemPage";
import { CouncilPage } from "./pages/CouncilPage";
import { AcpPage } from "./pages/AcpPage";
import { DoctorPage } from "./pages/DoctorPage";
import { ModelAvailabilityProvider } from "./models/ModelAvailabilityContext";
import { RuntimeProvider } from "./runtime/RuntimeContext";

export function App() {
  return (
    <ThemeProvider>
      <RuntimeProvider>
        <ModelAvailabilityProvider>
          <AppShell>
            <SchemaStatusBanner />
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/providers" element={<ProvidersPage />} />
              <Route path="/providers/manage" element={<ProviderManagementPage />} />
              <Route path="/providers/add" element={<AddProviderPage />} />
              <Route path="/providers/:id/edit" element={<ProviderEditPage />} />
              <Route path="/providers/:id/models" element={<ProviderBlacklistPage />} />
              <Route path="/sessions" element={<SessionsPage />} />
              <Route path="/config" element={<ConfigPage />} />
              <Route path="/capabilities" element={<CapabilitiesPage />} />
              <Route path="/prompts" element={<PromptsPage />} />
              <Route path="/presets" element={<PresetsPage />} />
              <Route path="/system" element={<SystemPage />} />
              <Route path="/council" element={<CouncilPage />} />
              <Route path="/acp" element={<AcpPage />} />
              <Route path="/doctor" element={<DoctorPage />} />
            </Routes>
          </AppShell>
        </ModelAvailabilityProvider>
      </RuntimeProvider>
    </ThemeProvider>
  );
}
