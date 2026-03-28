/**
 * PrerequisitesStep — Tells users what they need before connecting.
 */
import { CheckCircle2, ExternalLink } from "lucide-react";

const prerequisites = [
  {
    label: "Claw3D server running",
    detail: "Start the local server with npm run dev",
    command: "npm run dev",
  },
  {
    label: "Claude Code installed",
    detail: "Required for AI agent capabilities",
    link: "https://docs.anthropic.com/en/docs/claude-code",
    linkLabel: "Claude Code docs",
  },
  {
    label: "Gateway URL and token",
    detail: "Configured in ~/.claw3d-claude/claw3d/settings.json or .env file",
  },
  {
    label: "Node.js 20+",
    detail: "Required for running Claw3D locally",
    link: "https://nodejs.org",
    linkLabel: "Download Node.js",
  },
] as const;

export const PrerequisitesStep = () => (
  <div className="space-y-2.5">
    <p className="text-[13px] leading-5 text-white/70">
      Make sure you have these ready before connecting. If you already have
      the server running, you can skip this step.
    </p>

    <div className="space-y-1.5">
      {prerequisites.map(({ label, detail, ...rest }) => (
        <div
          key={label}
          className="flex gap-2.5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2"
        >
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/30" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-white">{label}</p>
            <p className="mt-0.5 text-[10px] leading-4 text-white/55">{detail}</p>
            {"command" in rest ? (
              <code className="mt-1 block rounded bg-black/40 px-2 py-0.5 font-mono text-[10px] text-amber-300">
                {rest.command}
              </code>
            ) : null}
            {"link" in rest && rest.link ? (
              <a
                href={rest.link}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[10px] leading-4 text-amber-300 hover:text-amber-200"
              >
                {rest.linkLabel ?? "Learn more"}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        </div>
      ))}
    </div>

    <p className="text-[10px] leading-4 text-white/40">
      Need help? Check the{" "}
      <a
        href="https://github.com/jonesfernandess/Claw3D-Claude"
        target="_blank"
        rel="noopener noreferrer"
        className="text-amber-300/70 hover:text-amber-200"
      >
        project repository
      </a>
      .
    </p>
  </div>
);
