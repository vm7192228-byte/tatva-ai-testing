import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getAuthenticatedSession: vi.fn(), consumeSharedRateLimit: vi.fn() }));
vi.mock("../lib/auth-api.server", () => ({ getAuthenticatedSession: mocks.getAuthenticatedSession }));
vi.mock("../lib/shared-rate-limit.server", () => ({ consumeSharedRateLimit: mocks.consumeSharedRateLimit }));
import { handleBillingApiRequest } from "../lib/billing-api.server";
import { handleChatApiRequest } from "../lib/chat-api.server";
import { handleChatGenerationsApiRequest } from "../lib/chat-generations.server";
import { handleConversationsApiRequest } from "../lib/conversations-api.server";
import { handleMediaApiRequest } from "../lib/media-api.server";
import { handleSocialApiRequest } from "../lib/social-api.server";
import { handleToolApprovalsApiRequest } from "../lib/tool-approvals.server";
import { handleUploadsApiRequest } from "../lib/uploads-api.server";
const env = {
 SUPABASE_URL:"https://workbench.supabase.co", SUPABASE_ANON_KEY:"publishable-test-key",
 SUPABASE_SERVICE_ROLE_KEY:"server-only-test-key", META_APP_ID:"meta-app-id", META_APP_SECRET:"meta-app-secret",
 INSTAGRAM_APP_ID:"instagram-app-id", INSTAGRAM_APP_SECRET:"instagram-app-secret",
 SOCIAL_TOKEN_SECRET:"social-token-secret-that-is-long-enough-for-tests"
};
const unavailable={configured:true,user:null,unavailable:true,cookies:[]};
function req(path:string,method="GET",body?:unknown){return new Request("https://codeforge.example"+path,{method,headers:{
 origin:"https://codeforge.example",cookie:"cf_access=existing-access-token; cf_refresh=existing-refresh-token",
 ...(body===undefined?{}:{"content-type":"application/json"})
},...(body===undefined?{}:{body:JSON.stringify(body)})});}
beforeEach(()=>{mocks.getAuthenticatedSession.mockResolvedValue(unavailable);mocks.consumeSharedRateLimit.mockResolvedValue({allowed:true,attempts:1,retryAfterSeconds:0});});
afterEach(()=>{mocks.getAuthenticatedSession.mockReset();mocks.consumeSharedRateLimit.mockReset();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function expectUnavailable(response:Response|null){expect(response).not.toBeNull();expect(response!.status).toBe(503);expect(await response!.json()).toMatchObject({error:"AUTH_UNAVAILABLE"});}
describe("Auth outages never become signed-out or guest state",()=>{
 it("does not downgrade a signed-in chat request to guest",async()=>expectUnavailable(await handleChatApiRequest(req("/api/chat","POST",{messages:[{role:"user",content:"Hello"}]}),env)));
 it("does not report a free plan or anonymous billing state",async()=>{await expectUnavailable(await handleBillingApiRequest(req("/api/billing/usage"),env));await expectUnavailable(await handleBillingApiRequest(req("/api/billing/status"),env));});
 it("does not create a checkout without verifying account ownership",async()=>expectUnavailable(await handleBillingApiRequest(req("/api/billing/create-order","POST",{planCode:"pro_monthly",phone:"9876543210"}),env)));
 it("does not report all social accounts disconnected",async()=>expectUnavailable(await handleSocialApiRequest(req("/api/social/status"),env)));
 it("does not start OAuth without verifying the account",async()=>expectUnavailable(await handleSocialApiRequest(req("/api/social/facebook/connect"),env)));
 it("does not issue private upload tokens or consume upload rate quota",async()=>{await expectUnavailable(await handleUploadsApiRequest(req("/api/uploads","POST",{operation:"sign",name:"picture.png",mimeType:"image/png",size:1200}),env));expect(mocks.consumeSharedRateLimit).not.toHaveBeenCalled();});
 it("does not start media generation with an unverified session",async()=>expectUnavailable(await handleMediaApiRequest(req("/api/media","POST",{type:"image",prompt:"A scenic mountain landscape"}),env)));
 it("does not report saved conversations as unauthenticated",async()=>expectUnavailable(await handleConversationsApiRequest(req("/api/conversations"),env)));
 it("does not reject durable chat recovery as unauthenticated",async()=>expectUnavailable(await handleChatGenerationsApiRequest(req("/api/chat/generations"),env)));
 it("does not reject a pending tool approval as signed out",async()=>expectUnavailable(await handleToolApprovalsApiRequest(req("/api/tool-approvals/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),env)));
});
