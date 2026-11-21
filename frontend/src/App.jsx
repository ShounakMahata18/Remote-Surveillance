import { useCallback, useState } from "react";
import Login from "./Login.jsx";
import Dashboard from "./Dashboard.jsx";

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("sessionToken"));

  const signIn = useCallback((nextToken) => {
    sessionStorage.setItem("sessionToken", nextToken);
    setToken(nextToken);
  }, []);

  const signOut = useCallback(() => {
    sessionStorage.removeItem("sessionToken");
    setToken(null);
  }, []);

  return token ? (
    <Dashboard token={token} onLogout={signOut} />
  ) : (
    <Login onLogin={signIn} />
  );
}
