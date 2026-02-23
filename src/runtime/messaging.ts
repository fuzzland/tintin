export interface PlanUpdateItem {
  step: string;
  status: string;
}

export type TextMessage = {
  type?: "text";
  text: string;
  final?: boolean;
  priority?: "user" | "background";
};

export type SessionMessage =
  | TextMessage
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
    }
  | {
      type: "tool_call";
      name: string;
      input?: string;
      priority?: "user" | "background";
    }
  | {
      type: "tool_output";
      name: string;
      output: string;
      callText?: string;
      formatAsCode?: boolean;
      priority?: "user" | "background";
    }
  | {
      type: "progress_event";
      event: import("./streamer/progress/types.js").ProgressEvent;
      priority?: "user" | "background";
    };

/** Type guard to check if a SessionMessage is a text message */
export function isTextMessage(message: SessionMessage): message is TextMessage {
  return message.type === undefined || message.type === "text";
}

export type SendToSessionFn = (sessionId: string, message: SessionMessage) => Promise<void>;
