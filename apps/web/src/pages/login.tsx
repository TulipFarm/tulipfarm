import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { safeAuthRedirect } from '@/lib/auth';
import { AuthForm, AuthLayout, AuthSubtitle } from '@/features/auth/form';

export function LoginPage() {
  const [pending, setPending] = useState(false);
  const redirect = safeAuthRedirect(new URLSearchParams(window.location.search).get('redirect'));
  return (
    <AuthLayout
      title="Log in to TulipFarm"
      subtitle={
        <AuthSubtitle
          link="We will email you a magic link to sign in."
          password="Use your password, or get a magic link by email."
        />
      }
      footer={
        <>
          New to TulipFarm?{' '}
          <span className="font-medium text-foreground underline underline-offset-4">
            <Link to="/register" search={{ redirect }}>
              Create an account
            </Link>
          </span>
        </>
      }
    >
      <AuthForm
        submitLabel="Email me a sign-in link"
        passwordLabel="Log in"
        linkLabel="Email me a sign-in link instead"
        googleLabel="Continue with Google"
        providersFirst
        pending={pending}
        onPendingChange={setPending}
      />
    </AuthLayout>
  );
}
