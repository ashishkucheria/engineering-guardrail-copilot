// Sample inputs for the demo. The "secret" is a fake value in a format no provider uses.
export const SAMPLES: { label: string; input: string }[] = [
  {
    label: "Diff: payment client",
    input: `diff --git a/src/payments/client.ts b/src/payments/client.ts
new file mode 100644
--- /dev/null
+++ b/src/payments/client.ts
@@ -0,0 +1,18 @@
+import { log } from "../log";
+
+const apiKey = "demo-0000-not-a-real-key-9f8e7d";
+
+export async function charge(customerId: string, amountCents: number) {
+  // TODO: add idempotency keys
+  const res = await fetch("https://payments.example.com/charges", {
+    method: "POST",
+    headers: { authorization: \`Bearer \${apiKey}\` },
+    body: JSON.stringify({ customerId, amountCents }),
+  });
+  try {
+    return await res.json();
+  } catch (e) {}
+}
+
+export const VERSION = "1";
`,
  },
  {
    label: "Snippet: clean",
    input: `export async function getUser(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT id, name FROM users WHERE id = ?").bind(id).first();
  if (!row) throw new NotFoundError(\`user \${id}\`);
  return row;
}
`,
  },
];
