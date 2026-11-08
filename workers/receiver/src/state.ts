import { z } from "zod";
import type { JsonFields } from "../../../shared/schemas";
import { DurableObject } from "cloudflare:workers";
import {
  fail,
  id,
  now,
  ProtocolError,
  type RpcResult,
  type Message,
  type Event,
  type TokenResponse,
  type ConversationState,
} from "../../../shared/protocol";

function put<T>(record: Record<string, T>, key: string, value: T): T {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });

  return value;
}

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

type Session = { expires: number; account?: string; agent?: string };

type Access = {
  expires: number;
  jkt: string;
  account: string;
  grant: string;
  scope: string[];
  resource?: string;
};

type Grant = { account: string; scope: string[]; expires: number; revoked?: boolean };

type Conversation = ConversationState & {
  id: string;
  account?: string;
  parent?: string;
  direct?: string;
  events: Event[];
  context: JsonFields;
  invitations: Record<string, string>;
};

type State = {
  client: string;
  sessions: Record<string, Session>;
  access: Record<string, Access>;
  grants: Record<string, Grant>;
  conversations: Record<string, Conversation>;
  requests: Record<string, { content: string; result: RpcResult }>;
  exchanged: boolean;
};

export type Input = {
  client: string;
  user?: string;
  session?: string;
  agent?: string;
  jkt?: string;
  secret?: string;
  token?: string;
  grant?: string;
  scope?: string[];
  resource?: string;
  conversation?: string;
  parent?: string;
  message?: Message;
  cursor?: string;
  wait?: boolean;
  account?: string;
  replacement?: string;
  requestId?: string;
  requestContent?: string;
  invitation?: string;
};

export type StoredCode = {
  client: string;
  redirect: string;
  state: string | null;
  challenge: string;
  scope: string[];
  expires: number;
};

export class ReplayGuard extends DurableObject<ReceiverEnv> {
  constructor(ctx: DurableObjectState, env: ReceiverEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS replay (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
    );
  }
  accept(key: string, expires: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM replay WHERE expires < ?", now());

      return (
        this.ctx.storage.sql
          .exec(
            "INSERT OR IGNORE INTO replay (id, expires) VALUES (?, ?) RETURNING id",
            key,
            expires,
          )
          .toArray().length === 1
      );
    });
  }
  saveCode(code: string, details: StoredCode) {
    this.ctx.storage.kv.put("code:" + code, details);
  }
  takeCode(code: string): StoredCode | undefined {
    return this.ctx.storage.transactionSync(() => {
      const value = this.ctx.storage.kv.get<StoredCode>("code:" + code);
      this.ctx.storage.kv.delete("code:" + code);

      return value;
    });
  }
}

export class CompanyUser extends DurableObject<ReceiverEnv> {
  dispatch(action: string, input: Input): string {
    try {
      return JSON.stringify(
        this.ctx.storage.transactionSync(() => {
          // 0.1's session-bound credentials and event format cannot be reused in 0.4.
          const state = this.ctx.storage.kv.get<State>("state:0.4") ?? {
            client: input.client,
            sessions: {},
            access: {},
            grants: {},
            conversations: {},
            requests: {},
            exchanged: false,
          };

          if (state.client !== input.client) fail("invalid_token", 401);

          for (const [key, value] of Object.entries(state.access))
            if (value.expires < now()) delete state.access[key];
          const result = this.perform(state, action, input);
          this.ctx.storage.kv.put("state:0.4", state);

          return result;
        }),
      );
    } catch (error) {
      if (error instanceof ProtocolError)
        return JSON.stringify({
          status: error.status,
          body: { error: error.code, ...error.extra },
        });
      throw error;
    }
  }
  private issue(state: State, input: Input, grant: Grant, refresh?: string): RpcResult {
    const scope = input.scope ?? grant.scope;

    if (!scope.length || scope.some((s) => !grant.scope.includes(s))) fail("invalid_scope");

    if (!input.jkt || !input.secret) fail("invalid_dpop_proof");
    state.access[input.secret] = {
      expires: now() + 3600,
      jkt: input.jkt,
      account: grant.account,
      grant: input.grant!,
      scope,
      resource: input.resource,
    };

    const body: TokenResponse = {
      access_token: input.token!,
      token_type: "DPoP",
      expires_in: 3600,
      scope: scope.join(" "),
      refresh_token: refresh,
    };

    return { status: 200, body: { ...body } };
  }
  private require(input: Input, required: string[]) {
    if (!input.account) fail("account_required", 401, { scope: required.join(" ") });

    if (required.some((s) => !input.scope?.includes(s)))
      fail("insufficient_scope", 403, { scope: required.join(" ") });
  }
  private event(c: Conversation, fields: Omit<Event, "id" | "created_at"> & { type: string }) {
    c.events.push({ id: id("evt_"), created_at: new Date().toISOString(), ...fields });
  }
  private stateEvent(c: Conversation, handoff = c.handoff, closed = c.closed) {
    if (c.handoff !== handoff || c.closed !== closed) {
      c.handoff = handoff;
      c.closed = closed;
      this.event(c, { type: "state", handoff, responder: c.responder, closed });
    }
  }
  private read(c: Conversation, cursor?: string) {
    const index = cursor ? c.events.findIndex((e) => e.id === cursor) : -1;

    if (cursor && index < 0) fail("invalid_cursor");
    const events = c.events.slice(index + 1, index + 101);

    return {
      conversation_id: c.id,
      events,
      cursor: events.at(-1)?.id ?? cursor ?? "",
      has_more: index + 1 + events.length < c.events.length,
      working: c.working,
      handoff: c.handoff,
      responder: c.responder,
      closed: c.closed,
    };
  }
  private getConversation(state: State, input: Input, value?: string): Conversation {
    const c = own(state.conversations, value ?? "");

    if (!c) fail("conversation_not_found", 404);

    if (c.account && !input.account) fail("account_required", 401, { scope: "orders:read" });

    if (c.account && input.account !== c.account) fail("conversation_not_found", 404);

    if (input.account) c.account = input.account;

    return c;
  }
  private reply(state: State, c: Conversation, input: Input) {
    const message = input.message!;
    c.context = { ...c.context, ...message.context };
    this.event(c, { type: "message", message: { ...message, id: input.requestId, role: "user" } });

    // Context-only messages update context without manufacturing a reply.
    if (message.text === undefined && message.data === undefined) return;
    const text = (message.text ?? "").toLowerCase();
    let reply: string;
    let data: JsonFields | undefined;

    if (/order|return|exchange/.test(text)) {
      const required = /exchange|return/.test(text)
        ? ["orders:read", "orders:write"]
        : ["orders:read"];

      if (!input.account || required.some((s) => !input.scope?.includes(s))) {
        this.event(c, {
          type: "authorization",
          error: "insufficient_scope",
          scope: required.join(" "),
        });
        reply =
          "Please sign in and approve access so I can help with order #1042. Your conversation will stay open.";
      } else {
        reply = state.exchanged
          ? "The simulated exchange is confirmed. No charge or shipment occurs in this demo."
          : "Order #1042 contains a Stormline shell in medium. The insulated version is available for $70 more. Review the simulated exchange in your agent before confirming.";
        data = state.exchanged
          ? { exchange_id: "exc_demo_1042", status: "confirmed" }
          : {
              order_id: "ord_1042",
              replacement_sku: "stormline-insulated-m",
              price_difference: 70,
            };
      }
    } else {
      reply =
        message.author.type === "human"
          ? "Hi! The Stormline insulated jacket is warmer than the shell and comes in medium. I can help look up your order once you approve access."
          : "Stormline shell: waterproof, uninsulated, $180. Stormline insulated: waterproof, warm lining, $250. Medium is in stock. Account access is required for orders and exchanges.";
      data = {
        products: [
          { sku: "stormline-shell-m", price: 180 },
          { sku: "stormline-insulated-m", price: 250 },
        ],
      };
    }

    this.event(c, {
      type: "message",
      message: {
        id: id("msg_"),
        role: "company",
        author: { type: "agent" },
        as_of_request: input.requestId,
        text: reply,
        data,
      },
    });

    if (!c.parent && /talk directly/.test(text))
      this.event(c, {
        type: "user_requested",
        reason: "The user can ask the automated store assistant directly about jacket options.",
      });
  }
  private perform(state: State, action: string, input: Input): RpcResult {
    // OAuth credentials live in a separate object from each pseudonymous User's Sessions.
    if (action === "sign-in" || action === "refresh") {
      const grant =
        action === "refresh"
          ? state.grants[input.grant ?? ""]
          : { account: "demo-account", scope: input.scope ?? [], expires: now() + 30 * 86400 };

      if (!grant || grant.revoked || grant.expires < now()) fail("invalid_grant");

      if (action === "sign-in") state.grants[input.grant!] = grant;

      return this.issue(state, input, grant, action === "sign-in" ? input.replacement : undefined);
    }

    if (action === "revoke") {
      const g = state.grants[input.grant ?? ""];

      if (g) g.revoked = true;

      return { status: 200, body: {} };
    }

    if (action === "authenticate-token") {
      const t = state.access[input.secret ?? ""];

      if (
        !t ||
        t.expires < now() ||
        !state.grants[t.grant] ||
        state.grants[t.grant].revoked ||
        state.grants[t.grant].expires < now()
      )
        fail("invalid_token", 401);

      if (t.jkt !== input.jkt) fail("invalid_dpop_proof", 401);

      if (
        (t.resource && input.resource !== t.resource) ||
        (input.resource === this.env.RECEIVER_ORIGIN + "/poppy/conversations" &&
          t.resource !== input.resource)
      )
        fail("invalid_token", 401, {
          resource_metadata:
            this.env.RECEIVER_ORIGIN + "/.well-known/oauth-protected-resource/poppy/conversations",
        });

      return { status: 200, body: { account: t.account, scope: t.scope } };
    }

    if (!input.user || !input.session) fail("invalid_session");
    let session = own(state.sessions, input.session);

    if (session && session.expires < now()) fail("session_ended");

    if (!session)
      session = put(state.sessions, input.session, { expires: now() + 86400, agent: input.agent });

    if (input.account) {
      if (session.account && session.account !== input.account) fail("session_ended");
      session.account = input.account;
    }

    if (action === "orders") {
      this.require(input, ["orders:read"]);

      return {
        status: 200,
        body: {
          orders: [
            {
              id: "ord_1042",
              number: 1042,
              item: "Stormline shell",
              size: "M",
              price: 180,
              status: state.exchanged ? "exchange_confirmed" : "delivered",
            },
          ],
        },
      };
    }

    if (action === "exchange") {
      this.require(input, ["orders:write"]);

      if (input.replacement !== "stormline-insulated-m") fail("invalid_replacement");
      state.exchanged = true;

      return {
        status: 201,
        body: {
          exchange_id: "exc_demo_1042",
          order_id: "ord_1042",
          replacement_sku: input.replacement,
          price_difference: 70,
          status: "confirmed",
        },
      };
    }

    if (action === "events")
      return {
        status: 200,
        body: this.read(this.getConversation(state, input, input.conversation), input.cursor),
      };
    const old = own(state.requests, input.requestId!);

    if (old) {
      // Recheck ownership/account even when returning a previously accepted request.
      this.getConversation(state, input, z.string().parse(old.result.body.conversation_id));

      if (old.content !== input.requestContent) fail("request_id_conflict", 409);

      return old.result;
    }

    let c: Conversation;

    if (action === "create") {
      let parent: Conversation | undefined;

      if (input.parent) {
        parent = this.getConversation(state, input, input.parent);

        if (input.invitation) {
          if (!parent.events.some((e) => e.id === input.invitation && e.type === "user_requested"))
            fail("invalid_request");
          const direct = own(parent.invitations, input.invitation);

          if (direct) {
            const child = this.getConversation(state, input, direct);

            const result = {
              status: 201,
              body: input.wait ? this.read(child, input.cursor) : { conversation_id: direct },
            };

            put(state.requests, input.requestId!, { content: input.requestContent!, result });

            return result;
          }
        }

        if (parent.closed) fail("conversation_closed", 409);

        if (parent.parent) fail("invalid_request");

        if (parent.direct)
          fail("direct_conversation_open", 409, { conversation_id: parent.direct });

        if (input.message && input.message.author.type !== "human") fail("invalid_request");
      }

      c = {
        id: id("cnv_"),
        working: false,
        handoff: "none",
        responder: "agent",
        closed: false,
        events: [],
        context: {},
        invitations: {},
        parent: input.parent,
        account: input.account ?? parent?.account,
      };
      state.conversations[c.id] = c;

      if (parent) {
        parent.direct = c.id;

        if (input.invitation) parent.invitations[input.invitation] = c.id;
        this.event(parent, { type: "direct_opened", conversation_id: c.id });
      }
    } else c = this.getConversation(state, input, input.conversation);

    if (input.cursor && !c.events.some((e) => e.id === input.cursor)) fail("invalid_cursor");

    if (action !== "close") {
      if (c.closed) fail("conversation_closed", 409);

      if (c.direct) fail("direct_conversation_open", 409, { conversation_id: c.direct });
    }

    if (action === "create" || action === "message") {
      if (c.parent && input.message?.author.type === "agent") fail("invalid_request");

      if (input.message) this.reply(state, c, input);
      else
        this.event(c, {
          type: "message",
          message: {
            id: id("msg_"),
            role: "company",
            author: { type: "agent" },
            text: "Hi! What would you like to know about our jackets?",
          },
        });
    } else if (action === "handoff") {
      this.stateEvent(c, "pending");
      this.event(c, {
        type: "message",
        message: {
          id: id("msg_"),
          role: "company",
          author: { type: "agent" },
          as_of_request: input.requestId,
          text: "There is no staffed support desk in this demo. I can continue helping as the automated assistant.",
        },
      });
      this.stateEvent(c, "none");
    } else if (action === "handoff/cancel") this.stateEvent(c, "none");
    else if (action === "close") {
      this.stateEvent(c, "none", true);

      if (c.direct) {
        this.stateEvent(state.conversations[c.direct], "none", true);
        this.event(c, { type: "direct_closed", conversation_id: c.direct });
        delete c.direct;
      }

      if (c.parent) {
        const p = state.conversations[c.parent];

        if (p.direct === c.id) {
          delete p.direct;
          this.event(p, { type: "direct_closed", conversation_id: c.id });
        }
      }
    } else fail("not_found", 404);

    const result = {
      status: action === "create" ? 201 : 202,
      body: input.wait ? this.read(c, input.cursor) : { conversation_id: c.id },
    };

    put(state.requests, input.requestId!, { content: input.requestContent!, result });

    return result;
  }
}
