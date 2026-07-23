import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider, usePrivy, useWallets, useCreateWallet } from "@privy-io/react-auth";
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
    const { wallets } = useWallets();
    const { createWallet } = useCreateWallet();

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

    // Email login authenticates BEFORE the embedded wallet exists, and `user`
    // lags its creation — so take whichever source has it first and hold the app
    // back until then. Without an address every API call is missing
    // X-Wallet-Address and the server rejects it.
    const address = user?.wallet?.address ?? wallets[0]?.address;
    // Privy only auto-creates the embedded wallet during a login, so an account
    // that logged in before that was configured lands here with none — offer to
    // create it rather than spinning forever.
    if (!address) {
        return (
            <div className="gate">
                <div className="gate-card">
                    <h1>🌲 fangornmd</h1>
                    <p>You need a wallet — it's your identity on the Fangorn network.</p>
                    <button className="btn primary" onClick={() => createWallet()}>Create my wallet</button>
                    <button className="btn ghost" onClick={logout}>Log out</button>
                </div>
            </div>
        );
    }

    return <App address={address} onLogout={logout} />;
}

const root = createRoot(document.getElementById("root"));
root.render(
    <React.StrictMode>
        {APP_ID ? (
            <PrivyProvider
                appId={APP_ID}
                config={{
                    loginMethods: ["email", "wallet"],
                    // v3 nests this per chain — a top-level `createOnLogin` is
                    // silently ignored and defaults to "off", which leaves email
                    // users with no wallet at all (and so no Fangorn identity).
                    embeddedWallets: {
                        ethereum: { createOnLogin: "users-without-wallets" },
                        showWalletUIs: false,
                    },
                    appearance: { theme: "light", accentColor: "#2f7d4f" },
                    // Fangorn settles on Arbitrum Sepolia — the embedded wallet
                    // must have that chain configured or sends throw.
                    defaultChain: arbitrumSepolia,
                    supportedChains: [arbitrumSepolia],
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
