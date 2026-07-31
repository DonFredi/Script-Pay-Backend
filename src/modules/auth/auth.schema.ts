import { z } from "zod";

// Matches register.schema.ts exactly (username/email/password/confirmPassword),
// re-validated server-side — never trust client-side validation alone.
export const signupSchema = z
  .object({
    username: z.string().min(3).max(50).trim(),
    email: z.string().email().trim().toLowerCase(),
    password: z.string().min(6).max(100),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type SignupDto = z.infer<typeof signupSchema>;

// Matches login.schema.ts exactly — direct email+password now that Firebase's
// ID-token round-trip is gone; this backend verifies the password hash itself.
export const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1),
});
export type LoginBodyDto = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
});
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(6).max(100),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});
export type VerifyEmailDto = z.infer<typeof verifyEmailSchema>;

export const resendVerificationSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
});
export type ResendVerificationDto = z.infer<typeof resendVerificationSchema>;
