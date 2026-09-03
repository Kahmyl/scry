const [encodedEvent] = process.argv.slice(2);

if (!encodedEvent || !process.send) throw new Error("CROSS_PROCESS_EVENT_ARGUMENTS_REQUIRED");

const event = JSON.parse(Buffer.from(encodedEvent, "base64url").toString("utf8"));
process.send(event);
