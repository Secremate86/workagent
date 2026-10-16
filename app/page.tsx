import { Suspense } from "react";
import { WorkAgentShell } from "@/components/workagent/WorkAgentShell";
import { I18nProvider } from "@/hooks/useI18n";

export default function Home() {
  return (
    <Suspense>
      <I18nProvider>
        <WorkAgentShell />
      </I18nProvider>
    </Suspense>
  );
}
