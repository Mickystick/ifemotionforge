export const healthRoutes = async (app) => {
    app.get("/health", async () => ({
        status: "ok",
        service: "lindero-api",
        timestamp: new Date().toISOString(),
    }));
};
//# sourceMappingURL=health.js.map