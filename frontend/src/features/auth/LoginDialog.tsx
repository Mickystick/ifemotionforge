import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { ApiError } from "../../lib/api";
import type { User } from "../../lib/permissions";
import { authApi } from "./api";

interface LoginDialogProps {
  onSignedIn: (user: User) => void;
  onClose: () => void;
}

export function LoginDialog({ onSignedIn, onClose }: LoginDialogProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      onSignedIn(await authApi.login(email, password));
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Unable to sign in.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog ariaLabel="Sign in" onClose={onClose}>
      <form className="login-dialog" onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">Lindero</p>
            <h2>Sign in to continue</h2>
          </div>
        </div>

        <div className="login-dialog-fields">
          <div className="form-field full-width">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          {error && <p className="form-error">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary login-submit" disabled={isSubmitting}>
            <span>{isSubmitting ? "Signing in…" : "Sign in"}</span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
