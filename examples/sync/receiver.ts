import { startLoggingReceiver } from "./receiver-server.ts";

const token = process.env.SYNC_RECEIVER_TOKEN;
if (!token) {
  console.log("Skipped: set SYNC_RECEIVER_TOKEN before starting the local logging receiver.");
} else {
  const receiver = await startLoggingReceiver({
    databasePath: process.env.SYNC_RECEIVER_DB ?? "./sync-receiver.sqlite",
    bearerToken: token,
    port: Number(process.env.PORT ?? 8788),
    onRecord: (record) => console.log(JSON.stringify(record, null, 2)),
  });
  console.log(
    `Logging receiver: ${receiver.url}. Expose this endpoint with a public HTTPS tunnel to receive remote deliveries.`,
  );
  const stop = async () => {
    await receiver.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
