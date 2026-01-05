export interface PlanUpdateItem {
  step: string;
  status: string;
}

export type SessionMessage =
  | {
      type?: "text";
      text: string;
      final?: boolean;
      priority?: "user" | "background";
    }
  | {
      type: "finalize";
      priority?: "user" | "background";
    }
  | {
      type: "plan_update";
      plan: PlanUpdateItem[];
      explanation?: string;
      priority?: "user" | "background";
    }
  | {
      type: "image";
      path: string;
      file: Buffer;
      filename: string;
      mimeType?: string;
      caption?: string;
      priority?: "user" | "background";
    };

export type SendToSessionFn = (sessionId: string, message: SessionMessage) => Promise<void>;
