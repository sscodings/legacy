import { NextRequest, NextResponse } from "next/server";
import { compileIntentDeterministic } from "@/lib/policy/compiler";
import { type VaultPolicyContext } from "@/lib/policy/types";

// Helper to stringify bigints safely for JSON responses
function sanitizeBigInts(obj: unknown): unknown {
  if (typeof obj === "bigint") {
    return obj.toString();
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeBigInts);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeBigInts(value);
    }
    return result;
  }
  return obj;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { intent, context } = body as { intent: string; context: VaultPolicyContext };

    if (!intent || typeof intent !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing or invalid 'intent' string." },
        { status: 400 }
      );
    }

    if (!context || !context.vaultAddress) {
      return NextResponse.json(
        { success: false, error: "Missing or invalid 'context' object." },
        { status: 400 }
      );
    }

    // Check if an external LLM provider API key is provided
    const geminiKey = process.env.GEMINI_API_KEY;
    const openAiKey = process.env.OPENAI_API_KEY;

    if (geminiKey) {
      try {
        const prompt = `You are the Legacy Inheritance Policy Compiler.
Given a user's natural language inheritance intent, translate it into a structured JSON policy.
Available Heirs: ${JSON.stringify(context.heirs)}
Available Assets: ${JSON.stringify(context.assets)}

Return ONLY valid JSON matching this exact structure:
{
  "rules": [
    {
      "beneficiary": "0x...",
      "beneficiaryName": "...",
      "assetId": "0x...",
      "assetLabel": "...",
      "token": "0x...",
      "percentageBps": 5000,
      "releaseDelaySeconds": 0,
      "fallbackBeneficiary": "0x0000000000000000000000000000000000000000"
    }
  ],
  "explanation": "..."
}
User Intent: "${intent}"`;

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: "application/json" },
            }),
          }
        );

        if (res.ok) {
          const geminiData = await res.json();
          const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const parsed = JSON.parse(rawText);
            if (Array.isArray(parsed.rules) && parsed.rules.length > 0) {
              return NextResponse.json({
                success: true,
                policy: sanitizeBigInts({
                  version: 1,
                  vault: context.vaultAddress,
                  trigger: "TRIGGER_SUCCESSION",
                  rules: parsed.rules,
                }),
                explanation: parsed.explanation || "Compiled via Gemini AI.",
              });
            }
          }
        }
      } catch (llmErr) {
        console.warn("External LLM provider failed, using deterministic compiler:", llmErr);
      }
    } else if (openAiKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openAiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: `You are the Legacy Policy Compiler. Available Heirs: ${JSON.stringify(
                  context.heirs
                )}, Available Assets: ${JSON.stringify(
                  context.assets
                )}. Return JSON { "rules": [...] } matching strict schema.`,
              },
              { role: "user", content: intent },
            ],
          }),
        });

        if (res.ok) {
          const aiData = await res.json();
          const parsed = JSON.parse(aiData.choices?.[0]?.message?.content || "{}");
          if (Array.isArray(parsed.rules) && parsed.rules.length > 0) {
            return NextResponse.json({
              success: true,
              policy: sanitizeBigInts({
                version: 1,
                vault: context.vaultAddress,
                trigger: "TRIGGER_SUCCESSION",
                rules: parsed.rules,
              }),
              explanation: "Compiled via OpenAI provider.",
            });
          }
        }
      } catch (llmErr) {
        console.warn("External OpenAI provider failed, using deterministic compiler:", llmErr);
      }
    }

    // Robust deterministic compiler fallback (100% reliable)
    const result = compileIntentDeterministic(intent, context);
    return NextResponse.json(sanitizeBigInts(result));
  } catch (err: unknown) {
    console.error("Policy compile error:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Failed to compile intent.",
      },
      { status: 500 }
    );
  }
}
