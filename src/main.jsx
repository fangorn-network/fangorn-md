import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { arbitrumSepolia } from "viem/chains";
import App from "./App.jsx";
import "./styles.css";

const APP_ID = import.meta.env.VITE_PRIVY_APP_ID;

// Login gate: nothing reaches the app (or the server) until a Privy session
// exists. On login Privy mints an embedded EVM wallet — that wallet IS the
// user's Fangorn publisher identity. App wires the token/address into the api
// layer itself (it only mounts when authenticated).
function Gate() {
    const { ready, authenticated, user, login, logout } = usePrivy();

    if (!ready) return <div className="gate">…</div>;

    if (!authenticated) {
        return (
            <div className="gate">
                <div className="gate-card">
                    <h1>🌲 fangornmd</h1>
                    <p>Your notes, published to a network you own — not a company's database.</p>
                    <button className="btn primary" onClick={login}>Log in</button>
                </div>
            </div>
        );
    }

    const address = user?.wallet?.address;
    return <App address={address} onLogout={logout} />;
}

const root = createRoot(document.getElementById("root"));
root.render(
    <React.StrictMode>
        {APP_ID ? (
            <PrivyProvider
                appId={APP_ID}
                config={{
                    embeddedWallets: { createOnLogin: "users-without-wallets" },
                    appearance: { theme: "light", accentColor: "#2f7d4f" },
                    // Fangorn settles on Arbitrum Sepolia — the embedded wallet
                    // must have that chain configured or sends throw.
                    defaultChain: arbitrumSepolia,
                    supportedChains: [arbitrumSepolia],
                    showWalletUis: false,
                }}
            >
                <Gate />
            </PrivyProvider>
        ) : (
            <div className="gate">
                <div className="gate-card">
                    <h1>🌲 fangornmd</h1>
                    <p>Set <code>VITE_PRIVY_APP_ID</code> in <code>.env</code> to enable login.</p>
                </div>
            </div>
        )}
    </React.StrictMode>,
);
